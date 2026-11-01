import fs from "node:fs";
import path from "node:path";

/**
 * File-based persistent memory. Human-readable and human-editable:
 * - lore.md            server facts, running jokes, events (edit it by hand too)
 * - diary.md           one line per day/event, written by the agent itself
 * - members/<id>.md    what the agent learned about each member
 */
export class MemoryStore {
  private membersDir: string;
  private loreFile: string;
  private diaryFile: string;

  constructor(dataDir: string, private memberMaxChars: number) {
    const root = path.resolve(process.cwd(), dataDir);
    this.membersDir = path.join(root, "members");
    this.loreFile = path.join(root, "lore.md");
    this.diaryFile = path.join(root, "diary.md");
    fs.mkdirSync(this.membersDir, { recursive: true });
    if (!fs.existsSync(this.loreFile)) {
      fs.writeFileSync(
        this.loreFile,
        "# Server lore\n\n<!-- Facts, running jokes, notable events. The owner can edit this file freely. -->\n",
      );
    }
    if (!fs.existsSync(this.diaryFile)) fs.writeFileSync(this.diaryFile, "# Agent diary\n");
  }

  getLore(maxChars = 1500): string {
    return fs.readFileSync(this.loreFile, "utf8").slice(0, maxChars);
  }

  appendDiary(line: string): void {
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(this.diaryFile, `- [${stamp}] ${line.replace(/\n+/g, " ").slice(0, 300)}\n`);
  }

  getRecentDiary(lines = 10): string {
    const all = fs.readFileSync(this.diaryFile, "utf8").trim().split("\n");
    return all.slice(-lines).join("\n");
  }

  private memberFile(userId: string): string {
    // userId is a Discord snowflake (digits only) — safe as a filename
    return path.join(this.membersDir, `${userId.replace(/\D/g, "")}.md`);
  }

  getMember(userId: string): string {
    const f = this.memberFile(userId);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }

  rememberMember(userId: string, displayName: string, fact: string): void {
    const f = this.memberFile(userId);
    const stamp = new Date().toISOString().slice(0, 10);
    let content = fs.existsSync(f)
      ? fs.readFileSync(f, "utf8")
      : `# ${displayName}\n`;
    content += `- [${stamp}] ${fact.replace(/\n+/g, " ").slice(0, 200)}\n`;
    // Cap per-member memory: drop oldest facts, keep the header line
    if (content.length > this.memberMaxChars) {
      const lines = content.split("\n");
      const header = lines[0];
      const facts = lines.slice(1).filter(Boolean);
      while (facts.length > 1 && [header, ...facts].join("\n").length > this.memberMaxChars) {
        facts.shift();
      }
      content = [header, ...facts].join("\n") + "\n";
    }
    fs.writeFileSync(f, content);
  }
}
