# Certificate Fonts

Required for `certificatePdf.service.ts`:

| File | Script | Notes |
|------|--------|-------|
| `public/Font/garamond/GARABD.TTF` | Latin | **Primary** — Microsoft Garamond Bold (matches PowerPoint template) |
| `public/Font/garamond/GARA.TTF` | Latin | Fallback regular |
| `NotoSerifThai-Bold.ttf` | Thai | Thai names (bold) |
| `NotoSerifThai-Regular.ttf` | Thai | Fallback |
| `EBGaramond-Bold.ttf` | Latin | Fallback if Garamond not bundled |
| `malgunbd.ttf` | Korean | Bold Korean |

**Note:** Certificate Latin names use **Garamond Bold 26pt** from `accp-api/public/Font/garamond/GARABD.TTF` when available.

Color: `#002060` / `rgb(0, 32, 96)`

Font files must be valid TTF/OTF (magic bytes checked). Invalid downloads are skipped automatically.
