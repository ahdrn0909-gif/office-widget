import fs from "node:fs";

const tag = (process.env.TAG || "").trim();
const asset = (process.env.ASSET || "").trim();
const sigPath = (process.env.SIG_PATH || "").trim();
const repo = (process.env.GITHUB_REPOSITORY || "").trim();
const notes = (process.env.NOTES || "").trim() || "새 버전이 설치됩니다.";

for (const [k, v] of Object.entries({ TAG: tag, ASSET: asset, SIG_PATH: sigPath, GITHUB_REPOSITORY: repo })) {
  if (!v) {
    console.error(`::error::환경변수 ${k} 가 비어있음`);
    process.exit(1);
  }
}

const version = tag.replace(/^v/, "");
const signature = fs.readFileSync(sigPath, "utf8").trim();

if (!signature) {
  console.error("::error::서명(.sig) 내용이 비어있음");
  process.exit(1);
}

const data = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${asset}`,
    },
  },
};

fs.writeFileSync("latest.json", JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(JSON.stringify(data, null, 2));
