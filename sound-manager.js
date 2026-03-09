class TarhalSoundManager {
    constructor() {
        this.enabled = true; // تفعيل افتراضي
        this.volume = 0.8;
        this.audioContext = null;
        this.isPlaying = false;
        this.loopInterval = null;
        this.oscillator = null;
        this.gainNode = null;
        
        console.log('🎵 Sound Manager Pro initialized');
        
        // تهيئة AudioContext عند أول تفاعل
        this.setupAudioContext();
    }
    
    setupAudioContext() {
        const initAudio = () => {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log('✅ AudioContext created');
            }
        };
        
        ['click', 'touchstart', 'keydown'].forEach(event => {
            document.addEventListener(event, initAudio, { once: true });
        });
    }
    
    // صوت تنبيه طلب الرحلة - مستمر ومتكرر
    playRideRequestSound() {
        if (!this.enabled || this.isPlaying) {
            console.log('⚠️ الصوت معطّل أو يعمل بالفعل');
            return;
        }
        
        console.log('🔊 بدء صوت طلب الرحلة - متكرر ومستمر');
        this.isPlaying = true;
        
        // إنشاء AudioContext إذا لم يكن موجوداً
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // تشغيل صوت متكرر باستمرار
        const playAlertPattern = () => {
            if (!this.isPlaying) return;
            
            try {
                // صوت 1: ترددات عالية
                this.playTone(900, 0.3);
                
                setTimeout(() => {
                    if (!this.isPlaying) return;
                    // صوت 2: تردد أعلى
                    this.playTone(1200, 0.3);
                }, 400);
                
                setTimeout(() => {
                    if (!this.isPlaying) return;
                    // صوت 3: تردد أعلى جداً
                    this.playTone(1500, 0.4);
                }, 800);
                
            } catch (error) {
                console.error('❌ خطأ في تشغيل الصوت:', error);
            }
        };
        
        // تشغيل فوري
        playAlertPattern();
        
        // تكرار كل ثانيتين
        this.loopInterval = setInterval(() => {
            if (this.isPlaying) {
                playAlertPattern();
            } else {
                clearInterval(this.loopInterval);
            }
        }, 2000);
        
        // اهتزاز مستمر للموبايل
        this.startVibration();
    }

    // صوت نجاح العملية (عند القبول مثلاً) - نغمة قصيرة ومبهجة
    playSuccessSound() {
        if (!this.enabled) return;

        console.log('🎉 تشغيل صوت النجاح');

        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        try {
            // نغمتين متصاعدتين سريعاً
            this.playTone(600, 0.1);
            setTimeout(() => this.playTone(900, 0.2), 100);

            // اهتزاز خفيف
            if ('vibrate' in navigator) {
                navigator.vibrate([100, 50, 100]);
            }
        } catch (error) {
            console.error('❌ خطأ في تشغيل صوت النجاح:', error);
        }
    }
    
    // دالة تشغيل نغمة
    playTone(frequency, duration) {
        try {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            
            gainNode.gain.setValueAtTime(this.volume, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + duration);
            
        } catch (error) {
            console.error('❌ خطأ في playTone:', error);
        }
    }
    
    // اهتزاز مستمر
    startVibration() {
        if (!('vibrate' in navigator)) return;
        
        const vibratePattern = () => {
            if (this.isPlaying) {
                navigator.vibrate([300, 100, 300, 100, 300]);
                setTimeout(vibratePattern, 2000);
            }
        };
        
        vibratePattern();
    }
    
    // إيقاف الصوت والاهتزاز
    stopRideRequestSound() {
        console.log('🛑 إيقاف صوت طلب الرحلة...');
        this.isPlaying = false;
        
        if (this.loopInterval) {
            clearInterval(this.loopInterval);
            this.loopInterval = null;
        }
        
        // إيقاف الاهتزاز
        if ('vibrate' in navigator) {
            navigator.vibrate(0);
        }
    }
    
    enable() {
        this.enabled = true;
        console.log('✅ الصوت مفعّل');
    }
    
    disable() {
        this.enabled = false;
        this.stopRideRequestSound();
        console.log('🔇 الصوت معطّل');
    }
    
    toggle() {
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
        return this.enabled;
    }
}

// تفعيل عالمي
window.soundManager = new TarhalSoundManager();
console.log('✅ Sound Manager ready');
