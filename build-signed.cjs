const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Node.js로 한글 경로에서 키 읽기
const keyPath = path.join(__dirname, '~', '.tauri', 'office-widget.key');
const keyContent = fs.readFileSync(keyPath, 'utf-8');

// ASCII 경로에 키 파일 복사 (Tauri가 한글 경로 못 읽어서)
const tempPath = 'C:\\tkey\\wkey.key';
fs.writeFileSync(tempPath, keyContent);
console.log('키 준비 완료. 빌드 시작...');

execSync('npm run tauri build', {
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY_PATH: tempPath
  },
  stdio: 'inherit',
  cwd: __dirname
});