import fs from "fs";
import { generateCertificatePdf } from "../src/services/certificatePdf.service.js";

async function main() {
  const cases = [
    { titlePrefix: "DR.", firstName: "John", lastName: "Smith" },
    {
      titlePrefix: "ดร.",
      firstName: "วิชัย",
      lastName: "สันติมาลีวรกุล",
    },
  ];

  for (const [index, recipient] of cases.entries()) {
    const { buffer, certificateName } = await generateCertificatePdf(
      "participation",
      recipient,
    );
    const out = `test-certificate-${index + 1}.pdf`;
    fs.writeFileSync(out, buffer);
    console.log(`Wrote ${out} (${certificateName}) ${buffer.length} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
