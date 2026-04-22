/**
 * Simple i18n: English + Spanish for operator-facing text.
 */

const strings = {
  en: {
    scanReady: 'Ready to scan',
    duplicate: 'DUPLICATE',
    invalidIsbn: 'INVALID ISBN',
    exception: 'EXCEPTION LOGGED',
    scanSuccess: 'SCANNED',
    trainingMode: 'TRAINING MODE',
    paused: 'PAUSED',
    scanning: 'SCANNING',
    enterName: 'Enter your name',
    startScanning: 'Start Scanning',
    endShift: 'End Shift',
    breakTimer: 'Break Timer',
    recentScans: 'Recent Scans',
    undoLastScan: 'Undo Last',
    exceptions: 'Log Exception',
    totalScans: 'Total Scans',
    pacePerHour: 'Pace / Hour',
    milestone: 'MILESTONE!',
    settings: 'Settings',
    fontSize: 'Font Size',
    volume: 'Volume',
    language: 'Language',
    theme: 'Theme',
    training: 'Training',
    break15: '15 min break',
    break30: '30 min break',
    breakDone: 'Break is over!',
    goal: 'Goal',
    messageFromSupervisor: 'Message from Supervisor',
    dismiss: 'Dismiss',
    resume: 'Resume',
    pause: 'Pause',
  },
  es: {
    scanReady: 'Listo para escanear',
    duplicate: 'DUPLICADO',
    invalidIsbn: 'ISBN INVÁLIDO',
    exception: 'EXCEPCIÓN REGISTRADA',
    scanSuccess: 'ESCANEADO',
    trainingMode: 'MODO ENTRENAMIENTO',
    paused: 'PAUSADO',
    scanning: 'ESCANEANDO',
    enterName: 'Ingrese su nombre',
    startScanning: 'Iniciar Escaneo',
    endShift: 'Terminar Turno',
    breakTimer: 'Temporizador de Descanso',
    recentScans: 'Escaneos Recientes',
    undoLastScan: 'Deshacer Último',
    exceptions: 'Registrar Excepción',
    totalScans: 'Total Escaneado',
    pacePerHour: 'Ritmo / Hora',
    milestone: '¡META ALCANZADA!',
    settings: 'Configuración',
    fontSize: 'Tamaño de Fuente',
    volume: 'Volumen',
    language: 'Idioma',
    theme: 'Tema',
    training: 'Entrenamiento',
    break15: 'Descanso 15 min',
    break30: 'Descanso 30 min',
    breakDone: '¡Descanso terminado!',
    goal: 'Meta',
    messageFromSupervisor: 'Mensaje del Supervisor',
    dismiss: 'Cerrar',
    resume: 'Reanudar',
    pause: 'Pausar',
  },
};

export function getLang() {
  return localStorage.getItem('app-lang') || 'en';
}

export function setLang(lang) {
  localStorage.setItem('app-lang', lang);
}

export function t(key) {
  const lang = getLang();
  return (strings[lang] && strings[lang][key]) || strings.en[key] || key;
}
