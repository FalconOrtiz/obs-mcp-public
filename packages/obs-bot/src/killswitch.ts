import { existsSync } from "node:fs";

export class KillSwitch {
  private killedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  get killed(): boolean {
    return this.killedAt !== null;
  }

  kill(now = Date.now()): void {
    if (this.killedAt === null) this.killedAt = now;
  }

  watchFile(path: string, intervalMs = 200): void {
    this.timer = setInterval(() => {
      if (existsSync(path)) this.kill();
    }, intervalMs);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
