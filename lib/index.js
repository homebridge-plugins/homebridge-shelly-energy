// Homebridge Shelly Energy: learns your appliances from a Shelly EM whole-house meter, reads Shellys and Matter devices on
// your home network for exact figures, and shows each appliance in Apple Home as a Matter outlet with live watts and energy.
// Created by @Wazza151. The platform is in platform.js.
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { ShellyHomeEnergyPlatform } from './platform.js';

export default api => { api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ShellyHomeEnergyPlatform); };
