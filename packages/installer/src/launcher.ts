const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export function launcherText(node: string, cli: string, directory: string, electronRunAsNode = false): string {
  return `#!/bin/sh\n${electronRunAsNode ? 'export ELECTRON_RUN_AS_NODE=1\n' : ''}exec ${quote(node)} ${quote(cli)} native-host --runtime-dir=${quote(directory)} "$@"\n`;
}

/** Parse only our fixed launcher grammar, never evaluate shell content. */
export function launcherPaths(text: string): { node: string; cli: string; directory: string; electronRunAsNode?: true } | undefined {
  const electronRunAsNode = text.startsWith('#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n');
  if (electronRunAsNode) text = text.replace('#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n', '#!/bin/sh\n');
  const quoted = String.raw`'((?:[^']|'\\'')*)'`;
  const match = new RegExp(`^#!/bin/sh\\nexec ${quoted} ${quoted} native-host --runtime-dir=${quoted} "\\$@"\\n$`).exec(text);
  if (!match) return;
  const decode = (value: string) => value.replaceAll("'\\''", "'");
  const [node, cli, directory] = match.slice(1).map(decode) as [string, string, string];
  if (launcherText(node, cli, directory) !== text) return;
  return { node, cli, directory, ...(electronRunAsNode ? { electronRunAsNode: true as const } : {}) };
}
