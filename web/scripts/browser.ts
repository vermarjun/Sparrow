// Override discovery for Chromium installations outside PATH (for example a macOS application bundle).
export function chromeExecutable(): string {
  const executable = process.env.CHROME_BIN || Bun.which('chromium') || Bun.which('chromium-browser') || Bun.which('google-chrome')
  if (!executable) throw new Error('Chromium was not found on PATH; set CHROME_BIN to its executable')
  return executable
}
