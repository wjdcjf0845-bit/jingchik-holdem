const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');

// 🎯 브라우저 AI가 최대한 억양을 타도록 쉼표를 넣은 부산 상남자 텍스트
const phrases = {
    check: "마! 간 함 보입시더, 체크!",
    call: "마! 상남자답게 기세로 콜하고 드간다 마!",
    fold: "아 마, 패가 똥패라 삼마 안되긋다, 다이!",
    raise: "마! 판때기 지대로 씨기 키워보자! 레이즈!",
    allin: "마! 전재산 싹 다 꼬라박는기다! 올인!!"
};

// 파일을 저장할 public/sounds 폴더 경로 설정
const dir = path.join(__dirname, 'public', 'sounds');

// 폴더가 없으면 자동으로 생성
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('📁 public/sounds 폴더를 생성했습니다.');
}

console.log('🎙️ TTS 음성 파일(MP3) 자동 생성을 시작합니다...');

// 각 액션별로 MP3 파일 생성
for (const [action, text] of Object.entries(phrases)) {
    const gtts = new gTTS(text, 'ko');
    const filePath = path.join(dir, `${action}.mp3`);
    
    gtts.save(filePath, function (err, result) {
        if (err) {
            console.error(`❌ ${action}.mp3 생성 실패:`, err);
        } else {
            console.log(`✅ ${action}.mp3 파일이 성공적으로 만들어졌습니다!`);
        }
    });
}