export type CertificateScript = "latin" | "thai" | "cjk" | "korean";

export interface ScriptRun {
  text: string;
  script: CertificateScript;
}

function charScript(char: string): CertificateScript {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x0e00 && code <= 0x0e7f) return "thai";
  if (code >= 0xac00 && code <= 0xd7af) return "korean";
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff)
  ) {
    return "cjk";
  }
  return "latin";
}

export function splitIntoScriptRuns(text: string): ScriptRun[] {
  if (!text) return [];

  const runs: ScriptRun[] = [];
  let current = "";
  let currentScript: CertificateScript | null = null;

  for (const char of text) {
    const script = charScript(char);
    if (currentScript === null) {
      currentScript = script;
      current = char;
      continue;
    }

    if (script === currentScript) {
      current += char;
    } else {
      runs.push({ text: current, script: currentScript });
      current = char;
      currentScript = script;
    }
  }

  if (current && currentScript) {
    runs.push({ text: current, script: currentScript });
  }

  return runs;
}
