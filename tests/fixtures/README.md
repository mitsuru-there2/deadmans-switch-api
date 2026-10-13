# Public certificate fixture

`AppleRootCA-G3.cer` is the public Apple Root CA G3 certificate, downloaded from [Apple PKI](https://www.apple.com/certificateauthority/AppleRootCA-G3.cer) on 2026-10-13. It contains no private key. It is used only to initialize the real Apple verifier in the workerd compatibility test; production trust roots must be configured through `APPLE_ROOT_CERTIFICATES` from the current [Apple PKI](https://www.apple.com/certificateauthority/) distribution.
