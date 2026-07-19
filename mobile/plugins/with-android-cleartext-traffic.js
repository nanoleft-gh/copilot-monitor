const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, configWithManifest => {
    const application = configWithManifest.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('AndroidManifest.xml is missing its application element.');
    }

    application.$ = application.$ ?? {};
    application.$['android:usesCleartextTraffic'] = 'true';
    return configWithManifest;
  });
};