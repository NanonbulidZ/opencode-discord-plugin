import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Captures the user's PC screen to a PNG file. Returns the file path. The Discord plugin will detect this and automatically send the image to the user's Discord DM.",
  args: {},
  async execute(_args, _context) {
    const { execSync } = await import("child_process")
    const { writeFileSync, unlinkSync, mkdtempSync } = await import("fs")
    const { join } = await import("path")
    const { tmpdir } = await import("os")

    const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-"))
    const psFile = join(tmpDir, "capture.ps1")
    const outFile = join(tmpDir, "screen.png")

    const psScript = [
      `Add-Type -AssemblyName System.Drawing`,
      `Add-Type -AssemblyName System.Windows.Forms`,
      "$screen = [System.Windows.Forms.Screen]::PrimaryScreen",
      "$bounds = $screen.Bounds",
      "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
      "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
      "$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)",
      `$bitmap.Save('${outFile.replace(/\\/g, "\\\\").replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$graphics.Dispose()",
      "$bitmap.Dispose()",
    ].join("\n")

    writeFileSync(psFile, psScript, "utf-8")
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, {
        timeout: 30000,
        windowsHide: true,
      })
      return outFile
    } finally {
      try { unlinkSync(psFile) } catch {}
    }
  },
})
