import { initializeApp } from 'firebase/app'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import { getFunctions } from 'firebase/functions'
import { getStorage } from 'firebase/storage'
const firebaseConfig = {
  apiKey: 'AIzaSyBOdc9DPdn2YqW3zG87Qzaj50TmteW4iBY',
  authDomain: 'irrigation-schedule-f8b69.firebaseapp.com',
  projectId: 'irrigation-schedule-f8b69',
  storageBucket: 'irrigation-schedule-f8b69.firebasestorage.app',
  messagingSenderId: '1016145843540',
  appId: '1:1016145843540:web:c7112a3d7061f5e31064c1'
}
const app = initializeApp(firebaseConfig)
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
})
export const auth = getAuth(app)
export const functions = getFunctions(app)
export const storage = getStorage(app)
