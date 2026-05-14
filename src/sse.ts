export type SseMessage = {
  id?: string | undefined;
  event?: string | undefined;
  data?: string | undefined;
  retry?: number | undefined;
};

export class SseParser {
  private buffer = "";
  private id: string | undefined;
  private event: string | undefined;
  private dataLines: string[] = [];
  private retry: number | undefined;

  feed(chunk: string) {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    while (true) {
      const boundary = this.findBoundary();
      if (!boundary) {
        break;
      }
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const message = this.consumeBlock(raw);
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  }

  flush() {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const message = this.consumeBlock(this.buffer);
    this.buffer = "";
    return message ? [message] : [];
  }

  private findBoundary() {
    const candidates = [
      { index: this.buffer.indexOf("\r\n\r\n"), length: 4 },
      { index: this.buffer.indexOf("\n\n"), length: 2 },
      { index: this.buffer.indexOf("\r\r"), length: 2 },
    ].filter((candidate) => candidate.index >= 0);
    return candidates.sort((a, b) => a.index - b.index)[0] ?? null;
  }

  private consumeBlock(raw: string): SseMessage | null {
    for (const line of raw.split(/\r\n|\r|\n/)) {
      this.consumeLine(line);
    }

    if (this.dataLines.length === 0) {
      this.event = undefined;
      this.dataLines = [];
      this.retry = undefined;
      return null;
    }

    const message: SseMessage = {
      id: this.id,
      event: this.event,
      data: this.dataLines.join("\n"),
      retry: this.retry,
    };
    this.event = undefined;
    this.dataLines = [];
    this.retry = undefined;
    return message;
  }

  private consumeLine(line: string) {
    if (!line || line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";

    if (field === "id") {
      this.id = value;
    } else if (field === "event") {
      this.event = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "retry") {
      const retry = Number(value);
      if (Number.isInteger(retry) && retry >= 0) {
        this.retry = retry;
      }
    }
  }
}
