<#
  Compatibility entry point for Craft's visual desktop adapter.

  OCR is bundled in `windows-vision-cli.ts` as local WebAssembly plus `assets/ocr` models.
  There is no dependency on tesseract.exe and no screenshot leaves this computer. Use:
    node --experimental-strip-types .\adapters\windows-vision-cli.ts --mode observe --executable notepad.exe --target-text "Save"
#>
[CmdletBinding()]
param()

Write-Error "Use the bundled Craft Node adapter: adapters/windows-vision-cli.ts. This compatibility script no longer invokes tesseract.exe."
exit 1
