{ pkgs }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs-18_x
    pkgs.chromium
    pkgs.glib
    pkgs.gobject-introspection
    pkgs.gtk3
    pkgs.nss
    pkgs.xdg-utils
    pkgs.fontconfig
    pkgs.freetype
    pkgs.libgbm
    pkgs.libdrm
    pkgs.mesa
    pkgs.alsa-lib
    pkgs.at-spi2-atk
    pkgs.at-spi2-core
    pkgs.dbus
    pkgs.expat
    pkgs.libxkbcommon
    pkgs.libxshmfence
  ];

  shellHook = ''
    export PUPPETEER_EXECUTABLE_PATH=${pkgs.chromium}/bin/chromium
    export DNS_SERVER="1.1.1.1"
  '';
}