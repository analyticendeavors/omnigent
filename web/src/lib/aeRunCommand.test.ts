import { describe, expect, it } from "vitest";
import {
  stripHiddenChars,
  codeBlockLanguage,
  commandText,
  detectDangers,
  isRunnableBlock,
  looksLikeCommand,
  openPowerShellConstruct,
  openShellConstruct,
  planRun,
  terminalShellKind,
} from "./aeRunCommand";

describe("codeBlockLanguage", () => {
  it("reads the language-* class Streamdown puts on the code element", () => {
    expect(codeBlockLanguage("language-bash")).toBe("bash");
    expect(codeBlockLanguage("foo language-PowerShell bar")).toBe("powershell");
    expect(codeBlockLanguage("foo")).toBeNull();
    expect(codeBlockLanguage(undefined)).toBeNull();
  });
});

describe("isRunnableBlock", () => {
  it.each(["bash", "sh", "shell", "zsh", "powershell"])("runs a %s fence", (lang) => {
    expect(isRunnableBlock(lang, "anything at all")).toBe(true);
  });

  it.each(["python", "json", "yaml", "ts", "text", "diff"])("never runs a %s fence", (lang) => {
    expect(isRunnableBlock(lang, "ls -la")).toBe(false);
  });

  it("never runs a console block without a `$ ` prompt (output cannot be told apart)", () => {
    expect(isRunnableBlock("console", "# apt-get update\nReading package lists... Done")).toBe(
      false,
    );
    expect(isRunnableBlock("console", "$ uptime\n 10:00 up 3 days")).toBe(true);
  });

  it("never runs an empty block", () => {
    expect(isRunnableBlock("bash", "  \n")).toBe(false);
  });

  it("runs an untagged block only when it reads as commands", () => {
    expect(isRunnableBlock(null, "sudo systemctl restart ae-omnigent")).toBe(true);
    expect(isRunnableBlock(null, '{"a": 1}')).toBe(false);
  });
});

describe("looksLikeCommand", () => {
  it("accepts known commands, paths, env prefixes, prompts, comments and continuations", () => {
    expect(looksLikeCommand("git status\ngit log --oneline -5")).toBe(true);
    expect(looksLikeCommand("./deploy/compose.sh pull")).toBe(true);
    expect(looksLikeCommand("~/bin/tool --flag")).toBe(true);
    expect(looksLikeCommand("OMNIGENT_SKIP_WEB_UI=true uv sync")).toBe(true);
    expect(looksLikeCommand("$ docker ps")).toBe(true);
    expect(looksLikeCommand("# restart it\nsystemctl --user restart ae-omnigent-host")).toBe(true);
    expect(looksLikeCommand("docker run \\\n  --rm \\\n  hello-world")).toBe(true);
  });

  it("rejects prose, data and code", () => {
    expect(looksLikeCommand("Restart the service and check the logs.")).toBe(false);
    expect(looksLikeCommand("key: value\nother: 2")).toBe(false);
    expect(looksLikeCommand("const x = 1;")).toBe(false);
    expect(looksLikeCommand("def main():\n    pass")).toBe(false);
    expect(looksLikeCommand("git status\nthen read the output")).toBe(false);
    expect(looksLikeCommand("# only a comment")).toBe(false);
  });

  it("rejects a block longer than a command list", () => {
    expect(looksLikeCommand(Array.from({ length: 21 }, () => "ls").join("\n"))).toBe(false);
  });
});

describe("commandText", () => {
  it("drops trailing whitespace and keeps everything else exactly", () => {
    expect(commandText("  ls -la  \n\n")).toBe("  ls -la");
  });

  it("keeps only prompted lines of a transcript, without the prompt", () => {
    const transcript = "$ df -h\nFilesystem Size\n/dev/sda1 100G\n$ free -m\n       total";
    expect(commandText(transcript)).toBe("df -h\nfree -m");
  });

  it("never treats a script as a transcript because of a `$ ` line in a heredoc", () => {
    const script = "cat > NOTES <<'EOF'\nTo build:\n$ make\nEOF";
    expect(commandText(script, "bash")).toBe(script);
  });

  it("keeps the heredoc body of a prompted command, with or without `> ` prompts", () => {
    expect(commandText("$ cat <<EOF\n> one\n> EOF\n$ ls\nfile", "console")).toBe(
      "cat <<EOF\none\nEOF\nls",
    );
    expect(commandText("$ cat <<EOF\none\nEOF\none", "console")).toBe("cat <<EOF\none\nEOF");
  });

  it("keeps the continuation lines of a prompted command", () => {
    expect(commandText("$ docker run \\\n  --rm hello\nHello from Docker")).toBe(
      "docker run \\\n  --rm hello",
    );
  });
});

describe("openShellConstruct", () => {
  it("is null for closed commands", () => {
    expect(openShellConstruct("echo 'a' \"b\" `c`")).toBeNull();
    expect(openShellConstruct('echo "it\'s fine"')).toBeNull();
    expect(openShellConstruct("echo 'say \"hi\"'")).toBeNull();
    expect(openShellConstruct("echo don\\'t")).toBeNull();
    expect(openShellConstruct("echo $'a\\'b'")).toBeNull();
    expect(openShellConstruct("grep x file # it's a comment")).toBeNull();
    expect(openShellConstruct("cat <<< 'here string'")).toBeNull();
  });

  it("is null for a closed heredoc, quoted or dashed", () => {
    expect(openShellConstruct("cat <<EOF > f\nline 'with quote\nEOF")).toBeNull();
    expect(openShellConstruct("cat <<'EOF'\n$HOME\nEOF\necho done")).toBeNull();
    expect(openShellConstruct("cat <<-END\n\tbody\n\tEND")).toBeNull();
    expect(openShellConstruct("cat <<A <<B\na\nA\nb\nB")).toBeNull();
  });

  it("flags a heredoc whose delimiter never comes", () => {
    expect(openShellConstruct("cat <<EOF > /etc/x.conf\nkey=value")).toEqual({
      kind: "heredoc",
      delimiter: "EOF",
    });
    expect(openShellConstruct('tee f <<"END"\nbody\nEN')).toEqual({
      kind: "heredoc",
      delimiter: "END",
    });
    expect(openShellConstruct("cat <<A <<B\na\nA\nb")).toEqual({ kind: "heredoc", delimiter: "B" });
  });

  it("flags unterminated quotes and backticks", () => {
    expect(openShellConstruct("echo 'unterminated")).toEqual({ kind: "single-quote" });
    expect(openShellConstruct('echo "unterminated\nmore')).toEqual({ kind: "double-quote" });
    expect(openShellConstruct('echo "escaped \\"')).toEqual({ kind: "double-quote" });
    expect(openShellConstruct("echo `date")).toEqual({ kind: "backtick" });
  });

  it("flags a trailing continuation, pipe or &&", () => {
    expect(openShellConstruct("docker run \\")).toEqual({ kind: "continuation" });
    expect(openShellConstruct("cat f |")).toEqual({ kind: "continuation" });
    expect(openShellConstruct("make &&\n")).toEqual({ kind: "continuation" });
    expect(openShellConstruct("echo done\\\\")).toBeNull();
  });
});

describe("openPowerShellConstruct", () => {
  it("is null for closed commands and here-strings", () => {
    expect(openPowerShellConstruct("Get-Process | Select-Object -First 5")).toBeNull();
    expect(openPowerShellConstruct("Write-Host 'it''s fine'")).toBeNull();
    expect(openPowerShellConstruct('$x = @"\nbody "quoted"\n"@\nWrite-Host $x')).toBeNull();
  });

  it("flags an open here-string, quote or continuation", () => {
    expect(openPowerShellConstruct("$x = @'\nbody")).toEqual({ kind: "here-string" });
    expect(openPowerShellConstruct("Write-Host 'open")).toEqual({ kind: "single-quote" });
    expect(openPowerShellConstruct('Write-Host "open')).toEqual({ kind: "double-quote" });
    expect(openPowerShellConstruct("Get-Item x `")).toEqual({ kind: "continuation" });
  });
});

describe("detectDangers", () => {
  const ids = (text: string) => detectDangers(text).map((d) => d.id);

  it("names sudo", () => {
    expect(ids("sudo apt update")).toEqual(["sudo"]);
    expect(ids("apt update && sudo apt upgrade")).toEqual(["sudo"]);
    expect(ids("echo pseudo-terminal")).toEqual([]);
  });

  it("names rm -rf in every flag spelling, and only recursive plus force", () => {
    for (const cmd of [
      "rm -rf /tmp/x",
      "rm -fr x",
      "rm -Rf x",
      "rm -r -f x",
      "rm --recursive --force x",
    ]) {
      expect(ids(cmd)).toEqual(["rm-rf"]);
    }
    expect(ids("sudo rm -rf /var/cache/x")).toEqual(["sudo", "rm-rf"]);
    expect(ids("rm -r x")).toEqual([]);
    expect(ids("rm -f x")).toEqual([]);
    expect(ids("git rm -rf --cached x")).toEqual([]);
  });

  it("names a download piped into a shell", () => {
    expect(ids("curl -fsSL https://example.com/install.sh | sh")).toEqual(["curl-sh"]);
    expect(ids("curl -fsSL https://example.com/i | sudo bash")).toEqual(["sudo", "curl-sh"]);
    expect(ids("wget -qO- https://example.com/i | bash -s --")).toEqual(["curl-sh"]);
    expect(ids('sh -c "$(curl -fsSL https://example.com/i)"')).toEqual(["curl-sh"]);
    expect(ids("bash <(curl -s https://example.com/i)")).toEqual(["curl-sh"]);
    expect(ids("curl -o out.json https://example.com | jq .")).toEqual([]);
  });

  it("names dd only as a command", () => {
    expect(ids("sudo dd if=image.iso of=/dev/sdb bs=4M")).toEqual(["sudo", "dd"]);
    expect(ids("dd if=/dev/zero of=f count=1")).toEqual(["dd"]);
    expect(ids("echo add dd-thing")).toEqual([]);
  });

  it("lists each danger once in a fixed order", () => {
    expect(ids("dd if=a of=b\nrm -rf c\nsudo ls\nsudo ls")).toEqual(["sudo", "rm-rf", "dd"]);
    expect(detectDangers("sudo ls")[0].message).toMatch(/password/);
  });
});

describe("stripHiddenChars", () => {
  it("keeps tabs and newlines, folds CRLF, drops the rest", () => {
    expect(stripHiddenChars("a\tb\r\nc\x07\x9b")).toEqual({ text: "a\tb\nc", removed: 2 });
  });
});

describe("planRun", () => {
  it("submits a closed block", () => {
    expect(planRun("ls -la\n", "bash")).toEqual({
      shell: "posix",
      text: "ls -la",
      removedHidden: 0,
      submit: true,
      hint: null,
      dangers: [],
    });
  });

  it("withholds Enter and gives a hint for an open heredoc", () => {
    const plan = planRun("sudo tee /etc/x <<EOF\nkey=1\n", "bash");
    expect(plan.submit).toBe(false);
    expect(plan.hint).toMatch(/<<EOF/);
    expect(plan.dangers.map((d) => d.id)).toEqual(["sudo"]);
  });

  it("removes hidden control characters, so the sheet shows what is sent", () => {
    const plan = planRun("echo safe\x1b[201~\u202e; rm x\r\nls\u200b", "bash");
    expect(plan.text).toBe("echo safe[201~; rm x\nls");
    expect(plan.removedHidden).toBe(3);
  });

  it("uses PowerShell rules for a powershell fence", () => {
    expect(planRun("Write-Host 'it''s'", "powershell").submit).toBe(true);
    expect(planRun("Write-Host 'it''s'", "bash").submit).toBe(true);
    expect(planRun("$s = @'\nx", "powershell").submit).toBe(false);
  });

  it("marks a powershell fence for a PowerShell shell and everything else for POSIX", () => {
    expect(planRun("Get-Process", "powershell").shell).toBe("powershell");
    expect(planRun("ls", "bash").shell).toBe("posix");
    expect(planRun("ls", null).shell).toBe("posix");
  });
});

describe("terminalShellKind", () => {
  it("reads PowerShell from the terminal's spec name only", () => {
    expect(terminalShellKind("pwsh")).toBe("powershell");
    expect(terminalShellKind("PowerShell")).toBe("powershell");
    expect(terminalShellKind("bash")).toBe("posix");
    expect(terminalShellKind("shell")).toBe("posix");
  });
});
