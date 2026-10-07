/** Limpa a saída do modelo: remove <think>, markdown e emojis (a resposta vai ser falada). */
export class Cleaner {
  private inThink = false;
  private carry = "";
  private started = false;

  private tidy(s: string): string {
    let out = s
      .replace(/[*#`_~>]/g, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/ {2,}/g, " ");
    if (!this.started) {
      out = out.trimStart();
      if (out) this.started = true;
    }
    return out;
  }

  push(chunk: string): string {
    let s = this.carry + chunk;
    this.carry = "";
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = s.indexOf("</think>");
        if (end < 0) {
          this.carry = s.slice(-8);
          return this.tidy(out);
        }
        s = s.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = s.indexOf("<think>");
      if (start >= 0) {
        out += s.slice(0, start);
        s = s.slice(start + 7);
        this.inThink = true;
        continue;
      }
      const lt = s.lastIndexOf("<");
      if (lt >= 0 && "<think>".startsWith(s.slice(lt))) {
        out += s.slice(0, lt);
        this.carry = s.slice(lt);
      } else {
        out += s;
      }
      return this.tidy(out);
    }
  }

  flush(): string {
    const rest = this.inThink ? "" : this.carry;
    this.carry = "";
    return this.tidy(rest);
  }
}
