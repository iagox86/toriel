// Paste and copy for the controller: ctrl-v (text or image), middle-click paste
// of the primary selection, and copying a selection out.
import { fmtBytes, MAX_IMAGE_BYTES } from "./attachments.ts";
import { Clipboard, copyFailureMessage, isTextType } from "./clipboard.ts";
import type { Host } from "./host.ts";
import { osc52Output, osc52Result } from "./osc52.ts";

export class ClipboardActions {
  readonly clipboard = new Clipboard();

  private readonly h: Host;
  private readonly canPaste: () => boolean;

  /** `canPaste`: whether a paste has somewhere to go (not while a panel or dialog is waiting for its own keys). */
  constructor(host: Host, canPaste: () => boolean) {
    this.h = host;
    this.canPaste = canPaste;
  }

  /** Text into the chat box the way a terminal paste would put it. */
  private insertPaste(text: string): void {
    this.h.editor.pasteText(text);
    this.h.tui.requestRender();
  }

  /** ctrl-v: the clipboard's text, or its image. */
  async paste(): Promise<void> {
    if (!this.canPaste()) {
      return;
    }
    if (this.clipboard.problem) {
      this.h.notify(`paste is off: ${this.clipboard.problem}`);
      return;
    }
    const types = await this.clipboard.types("clipboard");
    if (types.some(isTextType)) {
      const text = await this.clipboard.readText("clipboard");
      if (text) {
        this.insertPaste(text);
        return;
      }
    }
    await this.pasteImage();
  }

  /** The clipboard's image goes in as a marker in the chat box; the picture travels with the message. */
  private async pasteImage(): Promise<void> {
    if (this.h.switching.isOpen || !this.h.viewing) {
      this.h.notify("images can only be pasted inside a session");
      return;
    }
    const meta = this.h.metaForPath(this.h.viewing);
    if (meta?.acceptsImages === false) {
      this.h.notify(`${meta.model.split("/").pop()} does not take images - pick a model that does (/model)`);
      return;
    }
    const image = await this.clipboard.readImage();
    if (!image) {
      this.h.notify("the clipboard is empty (nothing to paste)");
      return;
    }
    if (image.data.length > MAX_IMAGE_BYTES) {
      this.h.notify(`that image is ${fmtBytes(image.data.length)}; the limit is ${fmtBytes(MAX_IMAGE_BYTES)}`);
      return;
    }
    this.insertPaste(this.h.attachments.add(image.mimeType, image.data));
    this.h.notify(`image attached (${fmtBytes(image.data.length)}) - it goes with your next message`);
  }

  /**
   * Middle click: paste whatever was last highlighted anywhere (the primary
   * selection). Returns false when there is no clipboard tool, so the click
   * goes on to the terminal layer as if toriel did not know about it.
   */
  onMiddleClick(): boolean {
    if (!this.clipboard.available) {
      // said, not silent: the click still goes on to the terminal layer
      if (this.canPaste()) {
        this.h.notify(`middle-click paste is off: ${this.clipboard.problem}`);
      }
      return false;
    }
    if (this.canPaste()) {
      void this.pastePrimary();
    }
    return true;
  }

  private async pastePrimary(): Promise<void> {
    const text = await this.clipboard.readText("primary");
    if (text) {
      this.insertPaste(text);
    }
  }

  /** Text selected in toriel goes to the clipboard and the primary selection, so ctrl-v and middle click both get it. */
  async copyText(text: string): Promise<boolean | string> {
    if (!this.clipboard.available) {
      // no clipboard tool (typically over ssh): ask the terminal, which never says whether it did
      this.h.tui.terminal.write(osc52Output(text));
      return osc52Result();
    }
    const ok = await this.clipboard.writeText(text, ["clipboard", "primary"]);
    return ok ? true : copyFailureMessage(this.clipboard.backend);
  }
}
