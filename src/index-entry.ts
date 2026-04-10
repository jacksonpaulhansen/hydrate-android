import { Capacitor } from '@capacitor/core';

const isAndroidNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

if (isAndroidNative) {
  const target = `${import.meta.env.BASE_URL}android.html`;
  const here = window.location.pathname;
  if (!here.endsWith('/android.html')) {
    window.location.replace(target);
  } else {
    void import('./main');
  }
} else {
  void import('./glasses');
}

