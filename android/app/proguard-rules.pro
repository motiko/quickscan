# R8 rules for the release build. Capacitor (@capacitor/android) and ML Kit ship their own
# consumer rules, which keep Capacitor plugins (including capacitor-native-ocr's NativeOcrPlugin,
# found by name from capacitor.plugins.json) and @JavascriptInterface bridges.

# capacitor-native-ocr compiles against ML Kit's Chinese, Devanagari, Japanese and Korean
# recognizers but only ships the ones enabled in variables.gradle (none here). Its code never
# creates a disabled one, so the missing classes are expected.
-dontwarn com.google.mlkit.vision.text.chinese.**
-dontwarn com.google.mlkit.vision.text.devanagari.**
-dontwarn com.google.mlkit.vision.text.japanese.**
-dontwarn com.google.mlkit.vision.text.korean.**

# Readable stack traces in Play Console crash reports (R8's mapping file goes into the bundle),
# without shipping the source file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
