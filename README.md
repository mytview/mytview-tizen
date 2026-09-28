# MytView for Samsung TV (Tizen)

The Samsung TV app for [MytView](https://mytview.com), a private, read-only player for the video
library on your own server. This is the same app that is waiting in Samsung's store review, as
source, so that owners of a Samsung TV can build it and load it on their own set today.

> **A temporary workaround.** The app was submitted to the Samsung store and we are waiting for
> Samsung's approval. Once it is listed, installing it from the TV's app store will be the way to
> get it, and this repository stays as the source of that app. Until then, this page is the only path,
> and it takes a computer, Samsung's free developer tools and about an hour the first time.

Samsung does not allow a packaged app to be shared and installed directly: every sideloaded package
must be signed with a certificate that names the **specific TV** it will run on. That is why there is
no download here, only source and a build script.

## What you need

- A **Samsung TV from 2018 or later** (Tizen 4.0 or newer). Tested on a 2018 Q7FN and a 2022 M8.
- A **MytView server** already running on your network ([install guide](https://mytview.com/docs/install/)),
  and the MytView phone app or a browser to sign the TV in.
- A computer with **[Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)**
  (with the *TV Extensions* package) and **Node.js** 18 or later.

## 1. Put the TV in developer mode

On the TV: open **Apps**, press **1 2 3 4 5** on the remote, switch **Developer mode** on, enter the
IP address of your computer, and restart the TV. Note the TV's IP address (Settings → General →
Network → Network Status).

## 2. Certificates

In Tizen Studio open **Tools → Certificate Manager** and create a **Samsung** certificate profile:
an *author* certificate (any name), then a *distributor* certificate for **TV**, where you add your
TV's **DUID**. The DUID appears in Tizen Studio's Device Manager once the TV is connected:

```bash
sdb connect <tv-ip>
sdb devices
```

Remember the profile name; the build uses it. A package signed for one TV will not install on another.

## 3. Build and install

```bash
git clone https://github.com/mytview/mytview-tizen.git
cd mytview-tizen
npm install                       # esbuild only
./package.sh <your-profile-name>  # bundles, stages and signs → MytView.wgt
tizen install -n MytView.wgt -t <tv-serial>   # the serial is the first column of `sdb devices`
```

`tizen` and `sdb` come with Tizen Studio (`~/tizen-studio/tools/ide/bin` and `~/tizen-studio/tools`);
add both to your PATH.

## 4. Sign in

Open MytView on the TV. It shows a QR code: scan it with the MytView phone app (iPhone or Android)
and the TV signs in by itself. Without the phone app, choose the code option, open **Link a TV** on
your server in a browser, and enter the code.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `tizen install` fails with error 118012 | The package is unsigned or signed for another TV: check the profile name and that the distributor certificate contains this TV's DUID. |
| The app opens to a blank screen | The bundle was not built before packaging. `./package.sh` always builds first; if you used the `tizen` CLI by hand, run `./build.sh` first. |
| The TV cannot be reached with `sdb connect` | Developer mode is off, the computer's IP entered on the TV is wrong, or the TV was not restarted after enabling it. |
| Video plays but audio is silent, or playback stutters | Report it with the file's codecs and the TV model: the server decides when to transcode and the fix usually lands there. |

## Updating

`git pull`, then `./package.sh` and `tizen install` again. The app keeps its sign-in.

## About this code

Plain ES-module JavaScript, bundled with esbuild into one classic script so that 2018 sets
(Chromium 56) run it. `js/nav.js` is the spatial remote-control navigation, `js/player.js` the
`<video>` playback and watch-state logic, `js/broker.js` and `js/paircrypto.js` the QR sign-in
(end-to-end encrypted; the relay never sees credentials). The app talks to the server's public
`/api/v1` contract, documented in the
[server repository](https://github.com/mytview/mytview-server/blob/main/docs/api.md).

Bug reports and pull requests are welcome; new features are usually decided server-side first so
every client behaves the same, so open an issue before a large change.

## License and trademark

The code is licensed under the **GPL-3.0** (see `LICENSE`). Copyright Imbarco CRM Solutions SL.
The MytView name and logo are not part of the license: please do not publish modified builds under
the MytView name or app id. Samsung, Tizen and Samsung TV are trademarks of Samsung Electronics
Co., Ltd.; this project is not affiliated with or endorsed by Samsung.

MytView is a solo project, built with heavy use of AI coding tools under its author's direction;
every release is tested on real TVs before it ships.
