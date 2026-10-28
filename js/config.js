// Caledonite settings. The Firebase part is filled in during setup.
export const APP = {
  name: 'Caledonite',
  version: '1.4.21'
};

// Firebase web app settings (these are public, not secrets; access is controlled by firestore.rules)
export const FIREBASE = {
  sdk: '12.6.0',
  config: {
    apiKey: 'AIzaSyDN_valkNmZFdG6TjWElHgFS38yAKsLsVk',
    authDomain: 'caledonite.firebaseapp.com',
    projectId: 'caledonite',
    storageBucket: 'caledonite.firebasestorage.app',
    messagingSenderId: '455880056208',
    appId: '1:455880056208:web:19bd85346512d5a407e715'
  },
  vapidKey: 'BINIENcoexRofLHRX58N2kf8cggGoIsjZqV-2d3AG4DLb55VekJvdiihyH-JGRRulFN2MW20vrngn4exEmZSedE'
};

export const HOUSEHOLD_PATH = 'households/main';
