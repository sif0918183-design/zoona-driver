// audio-utils.js - أدوات مساعدة للصوت
const AudioUtils = {
    // التحقق من دعم المتصفح
    isAudioSupported() {
        return !!(window.AudioContext || window.webkitAudioContext);
    },
    
    // الحصول على إذن الصوت
    async requestAudioPermission() {
        try {
            // طريقة حديثة (متوفرة في Chrome 71+)
            if (navigator.permissions && navigator.permissions.query) {
                const result = await navigator.permissions.query({ name: 'microphone' });
                return result.state === 'granted';
            }
            
            // طريقة قديمة
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
            
        } catch (error) {
            console.log('❌ إذن الصوت مرفوض:', error);
            return false;
        }
    },
    
    // إنشاء صوت مخصص
    createBeepSound(frequency = 800, duration = 200) {
        return new Promise((resolve) => {
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.frequency.value = frequency;
                oscillator.type = 'sine';
                
                gainNode.gain.setValueAtTime(0, audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01);
                gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);
                
                oscillator.start();
                oscillator.stop(audioContext.currentTime + duration / 1000);
                
                oscillator.onended = () => {
                    audioContext.close();
                    resolve(true);
                };
                
            } catch (error) {
                console.log('🔇 الصوت المخصص غير مدعوم');
                resolve(false);
            }
        });
    },
    
    // تشغيل سلسلة أصوات
    async playSequence(sounds) {
        for (const sound of sounds) {
            await new Promise(resolve => {
                setTimeout(() => {
                    window.soundManager?.play(sound.name, sound.options);
                    resolve();
                }, sound.delay || 0);
            });
        }
    }
};
