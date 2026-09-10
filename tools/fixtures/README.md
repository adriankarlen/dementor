# Synthetic media fixtures

`black-h264.mov` is a 0.4-second, silent, 32×32 black video in a QuickTime
container, encoded as H.264. It contains no personal media.

Generated with:

```sh
ffmpeg -v error -f lavfi -i 'color=c=black:s=32x32:r=5' -t 0.4 -an \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart black-h264.mov
```

`black-h264-tail.mov` is generated with the same command but without
`-movflags +faststart`, leaving the `moov` atom at EOF. The browser test extends
the `mdat` atom by 48 MiB before that metadata without moving media chunk offsets.
This checks that playback can start using head/tail ranges rather than a full
sequential download. The large fixture is built only in memory during the test.

`black-h264-444-pcm.mov` and `black-prores-pcm.mov` add a 440 Hz tone and use
non-baseline video/audio formats to exercise repair. Generate them with:

```sh
ffmpeg -v error -f lavfi -i 'color=c=black:s=32x32:r=5' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 0.4 \
  -c:v libx264 -pix_fmt yuv444p -c:a pcm_s16le black-h264-444-pcm.mov
ffmpeg -v error -f lavfi -i 'color=c=black:s=32x32:r=5' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 0.4 \
  -c:v prores_ks -profile:v 1 -pix_fmt yuv422p10le -c:a pcm_s16le black-prores-pcm.mov
```

Codec support varies by browser/OS. The browser test forces one original-source
failure, then exercises real FFmpeg repair and playback of the resulting MP4.
Backend tests also check H.264 remuxing, 4:4:4 conversion and AAC output.
FFmpeg/FFprobe are required for these repair tests and for runtime playback repair.
