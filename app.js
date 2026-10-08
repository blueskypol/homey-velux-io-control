'use strict';

const Homey = require('homey');

class VeluxHomeIOControlApp extends Homey.App {

  async onInit() {
    this.log('Velux home_io_control app initialized');
  }

}

module.exports = VeluxHomeIOControlApp;
