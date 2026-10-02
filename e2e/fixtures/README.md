# Test Fixtures

To create y4m video files for camera emulation:

```bash
ffmpeg -loop 1 -i document-on-desk.jpg -t 5 -pix_fmt yuv420p -r 30 document-on-desk.y4m
```

To use a custom video in tests, add to Chromium launch args:
```
--use-file-for-fake-video-capture=e2e/fixtures/document-on-desk.y4m
```
