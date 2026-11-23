import { signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleAuthProvider } from './lib/firebase.ts';

declare global {
  interface Window {
    TaskNovaFirebaseAuth?: {
      signInWithGoogle: () => Promise<{ idToken: string; email: string | null; displayName: string | null }>;
      signOutGoogle: () => Promise<void>;
    };
  }
}

window.TaskNovaFirebaseAuth = {
  async signInWithGoogle() {
    const result = await signInWithPopup(auth, googleAuthProvider);
    const idToken = await result.user.getIdToken();
    return {
      idToken,
      email: result.user.email,
      displayName: result.user.displayName,
    };
  },
  async signOutGoogle() {
    await signOut(auth);
  },
};
