# Notebook → Android APK (Sketchware Pro + AdMob) — Step by step

> ⚠️ Ye guide maine likhi hai, lekin main Sketchware Pro yahan chala nahi sakta, isliye **APK maine nahi banaya aur ye steps phone par test nahi hue**. Har step standard Sketchware Pro blocks/Android API par based hai. Kahin block ka naam thoda alag dikhe to uska matlab wahi dhundo. Kuch phat jaye to error ka screenshot/text bhejo, main fix bata dunga.

**Idea:** APK = ek WebView jo tumhari Vercel site kholta hai + neeche AdMob banner + PDF se pehle interstitial + "Watch ad → +1 credit" (rewarded). Website already in sab ke liye ready hai (`?app=1` detect karti hai).

---

## 0. Pehle ye karo
1. Website Vercel par deploy karo (README dekho) → URL milega, e.g. `https://notebook-xyz.vercel.app`
2. `pages/privacy.html` aur `pages/contact.html` mein **YOUR-EMAIL@example.com** apna real email se badlo.
3. AdMob account: admob.google.com → Apps → Add app (Android) → App ID milega (`ca-app-pub-XXXX~YYYY`) → 3 ad units banao: **Banner**, **Interstitial**, **Rewarded**.
4. ⚠️ **Development mein sirf Google ke TEST IDs use karo** (neeche diye). Apne real ads khud click karoge to AdMob account ban ho sakta hai.

| Cheez | Google TEST ID |
|---|---|
| App ID | `ca-app-pub-3940256099942544~3347511713` |
| Banner | `ca-app-pub-3940256099942544/6300978111` |
| Interstitial | `ca-app-pub-3940256099942544/1033173712` |
| Rewarded | `ca-app-pub-3940256099942544/5224354917` |

---

## 1. New project
- Sketchware Pro → **+** → App name `Notebook`, package `com.yourname.notebook`, min SDK 21+.
- **Manage → Permissions** (Project settings): `INTERNET`, `ACCESS_NETWORK_STATE`.
- **Library → AdMob → Enable** → App ID daalo (test wala) → apne phone ko **Test device** mein add karo (Logcat mein device ID milta hai).

## 2. Screen (main.xml)
- Root: **LinearVertical**, width/height = match_parent.
- Andar: **WebView** (`webview1`) — width match_parent, height 0, **weight = 1**.
- Uske neeche: **AdView** (`adview1`) — size `SMART_BANNER` (ya `BANNER`), unit id = Banner ID.

## 3. Components (left panel → Component → Add)
- **InterstitialAd** → `interstitial1` (unit id = Interstitial ID)
- **RewardedVideoAd** → `rewarded1` (unit id = Rewarded ID)

## 4. Logic → onCreate
Blocks (is order mein):
1. `webview1 setJavaScriptEnabled true`
2. **Add source directly** (ye zaroori hai — bina iske `localStorage` nahi chalega aur chats save nahi honge):
```java
webview1.getSettings().setDomStorageEnabled(true);
webview1.getSettings().setDatabaseEnabled(true);
webview1.setWebChromeClient(new android.webkit.WebChromeClient()); // alert/confirm/prompt chalne ke liye
```
3. `webview1 loadUrl "https://YOUR-SITE.vercel.app/?app=1"`  ← `?app=1` app-mode on karta hai
4. `adview1 loadAd` (banner)
5. `interstitial1 loadAd` , `rewarded1 loadAd`

## 5. More Blocks → `printPage` (PDF save)
Naya More Block banao `printPage`, uske andar **Add source directly**:
```java
android.print.PrintManager pm = (android.print.PrintManager) getSystemService(android.content.Context.PRINT_SERVICE);
android.print.PrintDocumentAdapter adapter = webview1.createPrintDocumentAdapter("Notebook");
pm.print("Notebook", adapter, new android.print.PrintAttributes.Builder().build());
```
Ye Android ka native print dialog kholta hai → wahan **"Save as PDF"** choose hota hai.

## 6. Logic → webview1 → onPageStarted (url)
Website apni commands URL se bhejti hai (`?nbcmd=print` / `?nbcmd=rewarded`). Inhe pakdo aur page load rok do:

- **if** `url contains "nbcmd=print"`
  - `webview1 stopLoading`
  - **if** `interstitial1 isLoaded`? → `interstitial1 show` (PDF se pehle ad — "PDF download page ad")
  - **else** → `printPage`
- **else if** `url contains "nbcmd=rewarded"`
  - `webview1 stopLoading`
  - **if** rewarded loaded → `rewarded1 show`, **else** `showMessage "Ad abhi ready nahi, thodi der baad try karo"` aur `rewarded1 loadAd`

## 7. Ad events
- **interstitial1 → onAdClosed**: `printPage` , phir `interstitial1 loadAd`
- **rewarded1 → onRewarded** (user ne pura ad dekha): 
  `webview1 loadUrl "javascript:window.onNbRewardEarned && window.onNbRewardEarned()"`
- **rewarded1 → onAdClosed**: `rewarded1 loadAd`
- (Optional) **adview1 → onAdFailedToLoad**: kuch nahi, ya hide.

## 8. Back button
- **onBackPressed**: **if** `webview1 canGoBack` → `webview1 goBack`, **else** `finish`.
  (Print overlay ke andar "← Back" button website ka apna hai.)

## 9. Build / test
- ▶ Run se APK install karo. Test checklist:
  - [ ] Site khulti hai, chat save hoti hai, app band-khol ke bhi rehti hai
  - [ ] Notes generate hote hain (3 credits/day, 4th par "Daily limit reached 😔" popup)
  - [ ] Popup mein **"🎬 Watch a short ad (+1)"** dikhta hai (sirf app mein) → ad → credit +1
  - [ ] **Download as PDF** → "Save as PDF" overlay → interstitial → print dialog → Save as PDF
  - [ ] Banner neeche dikhta hai (test ad "Test Ad" label ke saath)
- **Agar `?nbcmd=…` ke baad page reload ho jaye** (stopLoading kaam na kare): chats local save hoti hain, to kuch khota nahi — bas PDF dubara "Download as PDF" dabana padega. Batao, to main website side par alternative channel laga dunga.

## 10. Live jaane se pehle
1. Test IDs → apne **real** AdMob IDs (App ID library settings mein, 3 unit IDs blocks mein).
2. AdMob → App settings → **Privacy policy URL** = `https://YOUR-SITE.vercel.app/pages/privacy.html`.
3. Google Sign-In: Google Cloud Console → Authorized JavaScript origins mein Vercel domain hona chahiye. ⚠️ **Google sign-in embedded WebView mein aksar block hota hai ("disallowed_useragent")** — sign-in optional hai (REQUIRE_SIGN_IN mat lagana), app bina login ke chalta hai.
4. EU/UK users ke liye Google ka consent (UMP) chahiye hota hai — Sketchware mein built-in nahi; agar EU mein publish karna hai to sirf India/countries select karo.
5. Signed APK export karo (Sketchware Pro → Export signed APK). Meri jaankari mein Sketchware **AAB nahi banata**, aur Play Store naye apps ke liye AAB maangta hai — to Play Store ke liye baad mein Android Studio/online converter lagega; direct APK share (WhatsApp/website) ke liye ye theek hai.
6. Kabhi apne live ads khud click mat karo.
