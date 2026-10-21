/**
 * Remote paths typed into a terminal after an image paste or upload: quoted
 * so the shell sees each one as a single word, in the host's own style.
 */

const PLAIN = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** POSIX shells: plain when safe, else single quotes (`it's` → `'it'\''s'`). */
export function shellQuote(path: string): string {
  if (path !== '' && PLAIN.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Windows OpenSSH reports `/C:/Users/x`; cmd and PowerShell want `C:\Users\x`. */
export function windowsPath(path: string): string {
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  const local = drive ? `${drive[1]}${drive[2] ?? '\\'}` : path;
  return local.replaceAll('/', '\\');
}

/** One word per path for the host's shell, joined by spaces. */
export function typedPaths(paths: readonly string[], os: 'linux' | 'windows'): string {
  return paths
    .map((path) => {
      if (os === 'linux') return shellQuote(path);
      const local = windowsPath(path);
      return /[\s&()^%!'"`;,]/.test(local) ? `"${local.replaceAll('"', '')}"` : local;
    })
    .join(' ');
}

/** Whether `path` lies under one of the roots (no roots: anywhere). */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => root === '/' || path === root || path.startsWith(`${root}/`));
}

/**
 * Local paths typed into a local terminal: on Windows in double quotes when
 * they have spaces or characters PowerShell and cmd treat specially; POSIX
 * shells get single quotes.
 */
export function localPaths(paths: readonly string[], windows: boolean): string {
  return paths
    .map((path) => {
      if (!windows) return shellQuote(path);
      return /[\s&()^%!'"`;,$@{}[\]]/.test(path) ? `"${path.replaceAll('"', '')}"` : path;
    })
    .join(' ');
}
