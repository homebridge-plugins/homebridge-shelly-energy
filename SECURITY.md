# Security

## Reporting a problem

Please report security problems privately, through this repository's **Security → Report a vulnerability** page, not in a
public issue. Say what you found, how to see it, and which version you were on.

## How the plugin protects your home

- **Nothing leaves your home network.** No accounts, cloud services or analytics. Shelly and Matter addresses must be on the
  home network; anything else is refused. Find Shellys asks only the Homebridge computer's own network, and only when pressed.
- **Read-only to your devices.** It never switches a Shelly or Matter device; Apple Home tiles only show.
- **Your data is this account's only.** Its folder (`home-energy` in Homebridge's storage) and everything in it, including the
  Matter controller's credentials, backups and recordings, can be opened only by the account Homebridge runs as.
- **The settings page** reaches the plugin through a socket file only that account can open, with a random key: no network port.
- **The optional web page** (off until a PIN is set) answers home-network addresses and names only, and only requests from its
  own page. The PIN (6 to 32 characters) is kept as a scrypt hash; a signed-in browser holds a random key in an HttpOnly,
  SameSite=Strict cookie for 30 days. Five wrong PINs make that address wait 10 minutes, and 30 from the whole network pause
  sign-in for everyone. It can be set to **view only**. It can never change its own PIN or settings.
- **Plain HTTP.** The web page isn't encrypted, like most home devices' pages: anyone who can watch your Wi-Fi traffic could see
  the PIN. Use it only on a network you trust, and keep it view-only if others use your Wi-Fi.

## Packages

The plugin uses matter.js and the Homebridge UI helper. Every change is built and linted on each supported Node version and
checked by CodeQL, and Dependabot opens a pull request when a package has an update or a fix.
