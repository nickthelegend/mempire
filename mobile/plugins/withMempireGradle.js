const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Two things `app/build.gradle` needs that Expo does not put there.
 *
 * `android/` is generated and gitignored, so every `expo prebuild --clean`
 * throws away anything hand-edited into it. Both of these were hand-edited
 * once, and the very next clean prebuild silently reverted them — the release
 * build went back to being signed with the debug key, which produces an APK
 * that installs fine and can never be updated by a properly signed one.
 *
 * A plugin runs on every prebuild, so the generated project is correct by
 * construction rather than by someone remembering a step in DEPLOY.md.
 *
 *  1. **Release signing.** Points at `mobile/keys/mempire-release.keystore`,
 *     overridable by environment so CI can inject its own without a patch.
 *  2. **ABI splits.** A universal APK carries four architectures and any given
 *     phone uses one; arm64 alone is 29 MB against 70. The universal build is
 *     still produced for older armeabi-v7a devices and emulators.
 */
const SIGNING = `
        // Added by plugins/withMempireGradle.js — do not hand-edit, prebuild
        // regenerates this file.
        mempireRelease {
            storeFile System.getenv('MEMPIRE_KEYSTORE')
                ? file(System.getenv('MEMPIRE_KEYSTORE'))
                : rootProject.file('../keys/mempire-release.keystore')
            storePassword System.getenv('MEMPIRE_KEYSTORE_PASSWORD') ?: 'mempire-devnet'
            keyAlias System.getenv('MEMPIRE_KEY_ALIAS') ?: 'mempire'
            keyPassword System.getenv('MEMPIRE_KEY_PASSWORD') ?: 'mempire-devnet'
        }
`;

const SPLITS = `
    // Added by plugins/withMempireGradle.js
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a', 'x86_64'
            universalApk true
        }
    }
`;

module.exports = function withMempireGradle(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;

    if (!src.includes('mempireRelease')) {
      src = src.replace('    signingConfigs {', `    signingConfigs {${SIGNING}`);
      // The template signs release with the debug key and says so in a comment.
      // Matched loosely because that comment's wording has changed between
      // React Native versions and an exact match would silently no-op.
      src = src.replace(
        /(release\s*\{[^}]*?signingConfig\s+signingConfigs\.)debug/,
        '$1mempireRelease',
      );
    }

    if (!src.includes('splits {')) {
      src = src.replace('    signingConfigs {', `${SPLITS}\n    signingConfigs {`);
    }

    cfg.modResults.contents = src;
    return cfg;
  });
};
