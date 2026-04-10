import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { Capacitor } from '@capacitor/core';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  getRedirectResult,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
  serverTimestamp,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type { HydrateState } from './hydrate-shared';

export type CloudHydrateRecord = {
  state: HydrateState;
  clientUpdatedAt: string;
  source: 'phone' | 'glasses';
};

export type CloudSyncBootstrap = {
  configured: boolean;
  auth: Auth | null;
  user: User | null;
};

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let redirectHandled = false;

export function isCloudSyncConfigured(): boolean {
  return !!(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
}

function ensureFirebase(): { auth: Auth; db: Firestore } | null {
  if (!isCloudSyncConfigured()) return null;
  if (!app) {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
  return { auth: auth!, db: db! };
}

export async function bootstrapCloudSync(): Promise<CloudSyncBootstrap> {
  const firebase = ensureFirebase();
  if (!firebase) return { configured: false, auth: null, user: null };

  if (!redirectHandled) {
    redirectHandled = true;
    try {
      await getRedirectResult(firebase.auth);
    } catch {
      // Surface auth issues through auth-state UI rather than crashing startup.
    }
  }

  return {
    configured: true,
    auth: firebase.auth,
    user: firebase.auth.currentUser,
  };
}

export function listenForUserChange(callback: (user: User | null) => void): Unsubscribe {
  const firebase = ensureFirebase();
  if (!firebase) return () => undefined;
  return onAuthStateChanged(firebase.auth, callback);
}

type NativeFirebaseAuthPlugin = {
  signInWithGoogle?: (options?: Record<string, unknown>) => Promise<any>;
};

function getNativeFirebaseAuthPlugin(): NativeFirebaseAuthPlugin | null {
  const plugins = (window as any)?.Capacitor?.Plugins ?? (Capacitor as any)?.Plugins;
  return (plugins?.FirebaseAuthentication as NativeFirebaseAuthPlugin | undefined) ?? null;
}

function isLikelyEmbeddedWebView(): boolean {
  const ua = navigator.userAgent || '';
  const hasWvToken = /\bwv\b/i.test(ua);
  const hasAndroidWebViewToken = /; wv\)/i.test(ua);
  const hasGenericWebViewToken = /webview/i.test(ua);
  const hasEvenHubHint = /even[_\s-]?hub|evenrealities/i.test(ua);
  return hasWvToken || hasAndroidWebViewToken || hasGenericWebViewToken || hasEvenHubHint;
}

export async function signInWithGoogle(): Promise<void> {
  const firebase = ensureFirebase();
  if (!firebase) throw new Error('Cloud sync is not configured.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const isNativePlatform = Capacitor.isNativePlatform();
  if (isNativePlatform) {
    const nativeAuth = getNativeFirebaseAuthPlugin();
    if (!nativeAuth?.signInWithGoogle) {
      throw new Error(
        'Android Google sign-in requires the Capacitor Firebase Authentication plugin. ' +
        'Current webview redirect is blocked by Google (disallowed_useragent).',
      );
    }

    const result = await nativeAuth.signInWithGoogle();
    const idToken = result?.credential?.idToken ?? result?.idToken ?? null;
    const accessToken = result?.credential?.accessToken ?? result?.accessToken ?? null;
    if (!idToken && !accessToken) {
      throw new Error('Native Google sign-in did not return an idToken/accessToken.');
    }

    const credential = GoogleAuthProvider.credential(idToken, accessToken ?? undefined);
    await signInWithCredential(firebase.auth, credential);
    return;
  }

  const isLocalBrowserPreview = !isNativePlatform && ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  if (isLocalBrowserPreview) {
    await signInWithPopup(firebase.auth, provider);
    return;
  }

  if (isLikelyEmbeddedWebView()) {
    throw new Error(
      'Google sign-in is blocked in embedded webviews (disallowed_useragent). ' +
      'Use a secure browser page or the Android companion app with native Firebase auth plugin enabled.',
    );
  }

  await signInWithRedirect(firebase.auth, provider);
}

export async function signOutFromCloud(): Promise<void> {
  const firebase = ensureFirebase();
  if (!firebase) return;
  await signOut(firebase.auth);
}

function stateDoc(uid: string) {
  const firebase = ensureFirebase();
  if (!firebase) throw new Error('Cloud sync is not configured.');
  return doc(firebase.db, 'hydrateUsers', uid, 'state', 'current');
}

export async function fetchRemoteState(uid: string): Promise<CloudHydrateRecord | null> {
  const snapshot = await getDoc(stateDoc(uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as Partial<CloudHydrateRecord> | undefined;
  if (!data?.state || typeof data.clientUpdatedAt !== 'string') return null;
  return {
    state: data.state,
    clientUpdatedAt: data.clientUpdatedAt,
    source: data.source === 'glasses' ? 'glasses' : 'phone',
  };
}

export function subscribeToRemoteState(uid: string, callback: (record: CloudHydrateRecord | null) => void): Unsubscribe {
  return onSnapshot(stateDoc(uid), (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.data() as Partial<CloudHydrateRecord> | undefined;
    if (!data?.state || typeof data.clientUpdatedAt !== 'string') {
      callback(null);
      return;
    }
    callback({
      state: data.state,
      clientUpdatedAt: data.clientUpdatedAt,
      source: data.source === 'glasses' ? 'glasses' : 'phone',
    });
  });
}

export async function pushRemoteState(uid: string, state: HydrateState, source: 'phone' | 'glasses'): Promise<void> {
  await setDoc(stateDoc(uid), {
    state,
    source,
    clientUpdatedAt: state.lastModifiedAt,
    serverUpdatedAt: serverTimestamp(),
  }, { merge: true });
}
