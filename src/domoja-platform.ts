import http, { IncomingMessage, Server, ServerResponse } from "http";
import { Socket, io } from 'socket.io-client';
import {
  API,
  APIEvent,
  CharacteristicEventTypes,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
  Service,
} from "homebridge";
import { Device, replaceDates } from "./device";

const PLUGIN_NAME = "homebridge-domoja";
const PLATFORM_NAME = "DomojaPlatform";

/*
 * IMPORTANT NOTICE
 *
 * One thing you need to take care of is, that you never ever ever import anything directly from the "homebridge" module (or the "hap-nodejs" module).
 * The above import block may seem like, that we do exactly that, but actually those imports are only used for types and interfaces
 * and will disappear once the code is compiled to Javascript.
 * In fact you can check that by running `npm run build` and opening the compiled Javascript file in the `dist` folder.
 * You will notice that the file does not contain a `... = require("homebridge");` statement anywhere in the code.
 *
 * The contents of the above import statement MUST ONLY be used for type annotation or accessing things like CONST ENUMS,
 * which is a special case as they get replaced by the actual value and do not remain as a reference in the compiled code.
 * Meaning normal enums are bad, const enums can be used.
 *
 * You MUST NOT import anything else which remains as a reference in the code, as this will result in
 * a `... = require("homebridge");` to be compiled into the final Javascript code.
 * This typically leads to unexpected behavior at runtime, as in many cases it won't be able to find the module
 * or will import another instance of homebridge causing collisions.
 *
 * To mitigate this the {@link API | Homebridge API} exposes the whole suite of HAP-NodeJS inside the `hap` property
 * of the api object, which can be acquired for example in the initializer function. This reference can be stored
 * like this for example and used to access all exported variables and classes from HAP-NodeJS.
 */
let hap: HAP;
let Accessory: typeof PlatformAccessory;

export = (api: API) => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLATFORM_NAME, DomojaPlatform);
};

declare class GenericService extends Service {
  static readonly UUID: string;
  constructor(displayName?: string, subtype?: string);
}


function getService(serviceName: string): typeof GenericService | null {
  const service: typeof GenericService | null = (hap.Service as any)[serviceName];
  if (service && service.UUID) return service;
  return null;
}

function getAllServiceNames(): string[] {
  return Object.keys(hap.Service).filter(key => getService(key));
}

function getTransformedValue(transformSpec: AccessoryConfig["get"] | AccessoryConfig["set"], value: string | boolean | number): string | boolean | number {
  if (transformSpec && transformSpec.mapping) {
    for (let i = 0; i < transformSpec.mapping.length; i += 2) {
      if (value.toString() === transformSpec.mapping[i].toString()) {
        return transformSpec.mapping[i + 1];
      }
    }
  }
  return value;
}

type AccessoryConfig = {
  displayName: string;
  serviceConstructorName: string;
  characteristicName: string;
  set?: {
    mapping?: (string | number | boolean)[];
  },
  get?: {
    mapping?: (string | number | boolean)[];
  }
}

type AccessoryContext = {
  path: string;
  config: AccessoryConfig;
}

class DomojaPlatform implements DynamicPlatformPlugin {

  private readonly log: Logging;
  private readonly api: API;

  private requestServer?: Server;

  private readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  private socket?: Socket;

  private setCookie: string = '';
  private url: string;

  private devices: Map<string, Device> = new Map();

  private devicesLoaded = false;
  private platformDidFinishLaunching = false;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.url = config.url;

    // probably parse config or something here
    console.log(config);

    this.getCookiesFromLogin(config.url, config.auth.username, config.auth.password).then(setCookie => {
      if (setCookie === false) return; // error was logged previously

      this.setCookie = setCookie;

      this.loadDevices(config.url, setCookie).then(() => {
        this.loadAccessories();
        this.devicesLoaded = true;
        this.tryStartSocketToDomoja(config.url);
      });
    });

    log.info("Domoja platform finished initializing!");

    /*
     * When this event is fired, homebridge restored all cached accessories from disk and did call their respective
     * `configureAccessory` method for all of them. Dynamic Platform plugins should only register new accessories
     * after this event was fired, in order to ensure they weren't added to homebridge already.
     * This event can also be used to start discovery of new accessories.
     */
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.info("Domoja platform 'didFinishLaunching'");

      this.platformDidFinishLaunching = true;
      this.tryStartSocketToDomoja(config.url);

    });
  }

  async getCookiesFromLogin(url: string, username: string, password: string): Promise<string | false> {
    try {
      const target = (url.endsWith('/') ? url : url + '/') + "login.html";
      const response = await fetch(target, {
        method: 'POST',
        redirect: "manual",
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&remember_me=false`,
      });

      const text = await response.text(); // unused, just ensure the response is complete

      const setCookie = response.headers.get('Set-Cookie');

      if (setCookie) {
        this.log.info(`Logged in to domoja server`);
        return setCookie.split(';')[0];
      }

      this.log.error("Cannot connect to domoja server for login:", response.status, response.statusText);
      return false;

    } catch (error) {
      this.log.error("Cannot connect to domoja server for login:", error);
    };
    return false;
  }

  async loadDevices(url: string, cookies: string): Promise<void> {
    let devices: Device[] = [];
    try {
      const target = (url.endsWith('/') ? url : url + '/') + "devices";
      const response = await fetch(target, {
        headers: {
          "Cookie": cookies
        }
      });

      devices = await response.json();

      if (!devices) this.log.error("Cannot connect to domoja server to get devices:", response.status, response.statusText);

    } catch (error) {
      this.log.error("Cannot connect to domoja server to get devices:", error);
      return
    };

    if (devices) {
      replaceDates(devices);
      devices.forEach(d => {
        this.devices.set(d.path, d);
      });
      this.log.info(`Loaded ${devices.length} device(s) from domoja server`);
    }

  }

  tryStartSocketToDomoja(url: string) {

    if (!this.devicesLoaded) return;
    if (!this.platformDidFinishLaunching) return;

    this.log.info(`Establishing socket connection to domoja server`, url);

    this.socket = io(url, {
      extraHeaders: {
        'Referer': url,
        cookie: this.setCookie
      }
    });

    if (this.socket === undefined) {
      this.log.error(`Could not create socket to domoja server!`);
      return;
    }

    this.socket.on('change', (value: { id: string, oldValue: string, newValue: string, date: string }) => {
      if (!value.id) return;

      const device = this.devices.get(value.id);

      if (!device) {
        this.log.error(`Could not find device "${value.id}"!`);
        return;
      }

      let accessoriesWihThatName = this.accessories.filter(a => a.context.path === device.path);
      if (accessoriesWihThatName.length === 0) {
        this.log.debug(`Could not find accessory with path "${device.path}"!`);
        return;
      }
      if (accessoriesWihThatName.length > 1) {
        this.log.error(`Could find more than one accessory with path "${device.path}"! Found ${accessoriesWihThatName.length} accessories:`, accessoriesWihThatName);
        return;
      }
      const accessory = accessoriesWihThatName[0];

      this.updateAccessoryValue(accessory, value.newValue);
    });
    this.socket.on('connect', () => {
      this.log.info('Connected to domoja server');
    });
    this.socket.on('message', function (message: any) {
      console.log('message', message);
    });
    this.socket.on('connect_error', (error: any) => {
      this.log.error('connect_error with connection to domoja server:', error);
    });
    this.socket.on('error', (error: any) => {
      this.log.error('error with socket to domoja server:', error);
      this.socket!.close();
      this.socket!.connect();
    });
  }

  loadAccessories() {

    const configs = new Map<string, AccessoryConfig>([
      ['piscine.temperature', {
        displayName: 'Température piscine 3',
        serviceConstructorName: hap.Service.TemperatureSensor.name,
        characteristicName: "Current Temperature",
      }],
      ['aquarium.lampes', {
        displayName: 'Lampes aquarium 3',
        serviceConstructorName: hap.Service.Switch.name,
        characteristicName: "On",
        "get": {
          "mapping": ["ON", true, "OFF", false]
        },
        "set": {
          "mapping": [true, "ON", false, "OFF"]
        },
      }]
    ]);

    let countNew = 0;
    let countUpdated = 0;
    for (let [path, config] of configs) {
      const device = this.devices.get(path);
      if (!device) {
        this.log.warn(`While loading accessories: could not find device with path "${path}".`);
      } else {
        const existingAccessory = this.accessories.find(a => a.context.path === path);

        const justUpdate = existingAccessory && JSON.stringify(existingAccessory.context.config) !== JSON.stringify(config);

        if (justUpdate) {
          // configuration changed, let's recreate the accessory
          countUpdated++;
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          this.accessories.splice(this.accessories.findIndex(a => a.context.path === path), 1);
          this.addAccessory(device, config);
        } else if (!existingAccessory) {
          // a really new accessory
          countNew++;
          this.addAccessory(device, config);
        }

        const accessory = this.accessories.find(a => a.context.path === path);
        if (!accessory) this.log.error(`In loadAccessories, couldn't retrieve accessory "${path}" that we just added!`);
        else this.updateAccessoryValue(accessory, device.state.toString());
      }
    };

    this.log.info(`Loaded ${countNew} new accessory(ies) from configuration, ${countUpdated} updated.`);
  }

  updateAccessoryValue(accessory: PlatformAccessory<AccessoryContext>, newValue: string) {
    const service = accessory.getService(accessory.context.config.displayName);

    if (!service) {
      this.log.error(`While trying to update value of accessory "${accessory.context.path}": cannot get service ${accessory.context.config.serviceConstructorName}!`);
    } else {
      let characteristic = service.getCharacteristic(accessory.context.config.characteristicName);
      if (!characteristic) {
        this.log.error(`While trying to update value of accessory "${accessory.context.path}": cannot get characteristic ${accessory.context.config.characteristicName}!`);
      } else {
        let transformedValue: number | string | boolean = getTransformedValue(accessory.context.config.get, newValue);
        this.log.info(`${accessory.context.config.displayName} is now ${transformedValue}`);
        characteristic.updateValue(transformedValue);
      }
    }
  }

  async setDeviceValue(device: Device, value: string | boolean | number, callback: (err?: Error) => void) {
    try {
      const target = (this.url.endsWith('/') ? this.url : this.url + '/') + `devices/${device.path}`;
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          "Cookie": this.setCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `command=${encodeURIComponent(value)}`,
      });

      const text = await response.text(); // unused, just ensure the response is complete

      if (text === 'OK') {
        this.log.debug(`Device ${device.path} state set to ${value}`);
        callback();
      } else {
        this.log.error(`Cannot connect to domoja server to setDeviceValue (${device.path}: ${value}), got response.text="${text}":`, response.status, response.statusText);
        callback(new Error(`${response.status}  ${response.statusText}`));
      }

    } catch (error) {
      this.log.error(`Cannot connect to domoja server to setDeviceValue (${device.path}: ${value}):`, error);
      callback(error as Error);
    };
  }

  /*
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.log("Configuring accessory %s", accessory.displayName);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log("%s identified!", accessory.displayName);
    });

    const device = this.devices.get(accessory.context.path);

    const service = accessory.getService(accessory.context.config.displayName);

    if (!service) {
      this.log.error(`In configureAccessory: could not find service "${accessory.context.config.serviceConstructorName}" of accessory "${accessory.context.path}"`);
    } else {
      const characteristic = service.getCharacteristic(accessory.context.config.characteristicName);

      if (!characteristic) {
        this.log.error(`In configureAccessory: could not find characterisc "${accessory.context.config.characteristicName}" of accessory "${accessory.context.path}"`);
      } else {

        characteristic.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          const device = this.devices.get(accessory.context.path);

          if (!device) {
            const error = `While setting ${accessory.context.config.displayName} to ${value}: no device found with path "${accessory.context.path}"!`;
            this.log.error(error);
            callback(new Error(error));
          } else {
            let transformedValue: number | string | boolean = getTransformedValue(accessory.context.config.set, value.toString());

            this.setDeviceValue(device, transformedValue, (err) => {
              if (err) {
                this.log.warn(`${accessory.context.config.displayName} could not be set to ${value}:`, err);
              } else {
                this.log.info(`${accessory.context.config.displayName} was set to ${value}`);
              }
              callback(err);
            });
          }
        });
      }
    }

    this.accessories.push(accessory);
  }

  // --------------------------- CUSTOM METHODS ---------------------------

  addAccessory(device: Device, config: AccessoryConfig) {
    this.log.info("Adding new accessory with name %s", config.displayName);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases. But works in this specific example.
    const uuid = hap.uuid.generate(config.displayName);
    const accessory = new Accessory<AccessoryContext>(config.displayName, uuid);

    accessory.context = { path: device.path, config };

    const service = getService(config.serviceConstructorName);

    if (!service) {
      this.log.error(`Service "${config.serviceConstructorName}" does not exist. Existing services: ${getAllServiceNames().join(', ')}.`);
    } else {
      accessory.addService(service, config.displayName);
    }

    // check that characteristic will be OK
    const accService = accessory.getService(config.displayName);
    if (!accService) this.log.error(`Error: service "${config.serviceConstructorName}" was just added to accessory "${config.displayName}" but could not be retrieved!`);
    else {
      const characteristic = accService.getCharacteristic(config.characteristicName);
      if (!characteristic) {
        this.log.error(`Characteristic "${config.characteristicName}" does not exist for service "${config.serviceConstructorName}"! Possible characteristics are: ${accService.characteristics.map(c => c.displayName).join(', ')}.`);
      }
    }

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  removeAccessories() {
    // we don't have any special identifiers, we just remove all our accessories

    this.log.info("Removing all accessories");

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
    this.accessories.splice(0, this.accessories.length); // clear out the array
  }

  createHttpService() {
    this.requestServer = http.createServer(this.handleRequest.bind(this));
    this.requestServer.listen(18081, () => this.log.info("Http server listening on 18081..."));
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.url === "/add") {
      //this.addAccessory(new Date().toISOString());
    } else if (request.url === "/remove") {
      this.removeAccessories();
    }

    response.writeHead(204); // 204 No content
    response.end();
  }

  // ----------------------------------------------------------------------

}
