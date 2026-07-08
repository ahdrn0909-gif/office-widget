// Firebase 설정 - samu-1006b (사무실업무 앱과 동일 프로젝트)
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDUYSTmc11R0lXcPitHcAnsByE_fqz854Q",
  authDomain: "samu-1006b.firebaseapp.com",
  projectId: "samu-1006b",
  storageBucket: "samu-1006b.firebasestorage.app",
  messagingSenderId: "737784906505",
  appId: "1:737784906505:web:42ee017c90dca4059949d8",
  measurementId: "G-B81VEVL1XE"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
