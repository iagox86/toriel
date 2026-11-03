// Backs off the daemon's liveness poll for a session whose child does not answer, so a
// dead process is probed less and less often (every 2, 4, then at most every 8 ticks)
// instead of failing and logging every tick forever. A recovered child is polled again
// at once. Pure state, one instance per daemon.
export class PollBackoff {
  private readonly state = new Map<number, { wait: number; left: number }>();

  /** Whether session `id` is to be polled on this tick (a skipped tick counts down). */
  due(id: number): boolean {
    const s = this.state.get(id);
    if (!s || s.left <= 0) {
      return true;
    }
    s.left--;
    return false;
  }

  /** Record how the poll went: a dead child waits twice as many ticks as last time (up to 8). */
  result(id: number, dead: boolean): void {
    if (!dead) {
      this.state.delete(id);
      return;
    }
    const wait = Math.min((this.state.get(id)?.wait ?? 0) * 2 || 1, 8);
    this.state.set(id, { wait, left: wait });
  }

  forget(id: number): void {
    this.state.delete(id);
  }
}
