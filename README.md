<p align="center">
   <a href="https://github.com/homebridge-plugins/homebridge-shelly-energy"><img alt="homebridge-shelly-energy" src="https://raw.githubusercontent.com/homebridge-plugins/homebridge-shelly-energy/latest/branding/Homebridge_x_Shelly.png" width="600px"></a>
</p>
<span align="center">

## homebridge-shelly-energy

Homebridge plugin that learns your appliances from a Shelly whole-house energy meter and shows each one in Apple Home

[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-shelly-energy/latest?label=latest)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-shelly-energy)
[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-shelly-energy/beta?label=beta)](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Beta-Version)<br>
[![npm](https://img.shields.io/npm/dt/@homebridge-plugins/homebridge-shelly-energy)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-shelly-energy)
[![Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=hb-discord)](https://discord.gg/bHjKNkN)

</span>

### Plugin Information

- This plugin reads one Shelly energy meter on your whole house (a Shelly EM, Pro EM, 3EM or Gen1 EM) and works out what is using power. The plugin:
  - learns your appliances from the power steps that repeat, and counts each one's runs and energy per day and per hour
  - shows each appliance in Apple Home as a **Matter outlet with live watts and energy**, plus an **Other** outlet for the rest
  - reads Shelly plugs, relays and meters, and Matter plugs, for exact figures, and can find your Shellys on the network
  - learns each appliance's cycles (Eco, Quick…) and shows the time left in a run
  - works out the cost per day and per hour, and money-saving tips from your own readings
  - can show HomeKit tiles for when an appliance is running, and a **Cheap Power Now** tile
- Everything stays on your home network: no account, no cloud. The plugin only reads, and never switches anything.
- Everything is set up on the plugin's own page in the Homebridge UI.

### Prerequisites

- To use this plugin, you will need to already have:
  - [Node](https://nodejs.org): latest version of `v22`, `v24` or `v26` - any other major version is not supported.
  - [Homebridge](https://homebridge.io): `v2.4` or above, with Matter turned on for the bridge this plugin runs on - refer to link for more information and installation instructions.
  - A Shelly energy meter for the whole house, without a device password.
  - For live watts in the Home app: iOS `27` or above.

### Setup

- [Installation](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Installation)
- [Configuration](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Configuration)
- [Beta Version](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Beta-Version)
- [Node Version](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Node-Version)

### Features

- [Supported Devices](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Supported-Devices)
- [How It Learns](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/How-It-Learns)
- [Apple Home Tiles](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Apple-Home-Tiles)
- [Matter Devices](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Matter-Devices)
- [Web Page](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Web-Page)
- [Privacy and Data](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Privacy-and-Data)

### Help/About

- [Common Errors](https://github.com/homebridge-plugins/homebridge-shelly-energy/wiki/Common-Errors)
- [Support Request](https://github.com/homebridge-plugins/homebridge-shelly-energy/issues/new/choose)
- [Changelog](https://github.com/homebridge-plugins/homebridge-shelly-energy/blob/latest/CHANGELOG.md)

### Credits

- To [@Wazza151](https://github.com/Wazza151): the creator of this plugin.
- To the creators/contributors of [homebridge-appliance-monitor](https://github.com/rummeyer/homebridge-appliance-monitor) (MIT), whose ideas the run learning of measured appliances is based on, and whose matter.js controller calls the Matter device reading follows.
- To the creators/contributors of [matter.js](https://github.com/matter-js/matter.js), which reads your Matter devices.
- To the creators/contributors of [Homebridge](https://homebridge.io) who make this plugin possible.

### Disclaimer

- I am in no way affiliated with Shelly and this plugin is a personal project that I maintain in my free time.
- Use this plugin entirely at your own risk - please see licence for more information.
