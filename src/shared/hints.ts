// Install hints per OS for what Sparrow needs but cannot install itself.
import { existsSync } from 'node:fs';

/** The command that installs tmux here: brew on macOS, else the distro's package manager. */
export function tmuxInstallHint(platform: string = process.platform, has: (bin: string) => boolean = (b) => !!Bun.which(b)): string {
  if (platform === 'darwin') return 'brew install tmux';
  if (has('apt-get') || has('apt')) return 'sudo apt install tmux';
  if (has('dnf')) return 'sudo dnf install tmux';
  if (has('pacman')) return 'sudo pacman -S tmux';
  if (has('zypper')) return 'sudo zypper install tmux';
  if (has('apk')) return 'sudo apk add tmux';
  return existsSync('/etc/os-release') ? 'install tmux with your package manager' : 'install tmux (https://github.com/tmux/tmux/wiki/Installing)';
}
