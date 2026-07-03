/**
 * Android hardware back button (Capacitor shell only — spec §5.2.1b).
 *
 * On the website this module is inert. It reaches the `@capacitor/app` plugin
 * through the runtime global `window.Capacitor.Plugins.App` (the same pattern
 * `nativeLive.ts` uses for `CapacitorHttp`), so the web bundle gains no import
 * or dependency on Capacitor — the plugin only exists once the APK, built with
 * `@capacitor/app` and `cap sync`, registers it natively.
 *
 * Inside the APK it turns the phone's BACK key into an app-native close chain
 * (modal card → route detail → planner → sheet detent) instead of the webview
 * default, which would exit the app on the very first press.
 */

import { handleMobileBack } from '../ui/sidebar';

interface AppPlugin {
  addListener(event: 'backButton', handler: () => void): void;
  exitApp(): Promise<void>;
}

function getAppPlugin(): AppPlugin | null {
  const cap = (window as {
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { App?: AppPlugin } };
  }).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  const app = cap.Plugins?.App;
  return app && typeof app.addListener === 'function' ? app : null;
}

export function initNativeBack(): void {
  const app = getAppPlugin();
  if (!app) return;

  app.addListener('backButton', () => {
    // Consumed by an open panel/sheet → stay in the app; otherwise exit.
    if (!handleMobileBack()) {
      void app.exitApp();
    }
  });
}
