import http, { IncomingMessage, Server, ServerResponse } from "http";
import { Socket, io } from 'socket.io-client';
import {
  API,
  APIEvent,
  Characteristic,
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
import { AccessoryConfig, Config, StateMapping } from "./config";
import checkConfig from "./checkConfig";

const PLUGIN_NAME = "homebridge-domoja";
const PLATFORM_NAME = "DomojaPlatform";

const maxLoggedLoginRetries = 2;
const delayBetweenLoginAttempts = 10; // in seconds

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

function getServiceFromConstructorName(serviceName: string): typeof GenericService | null {
  const service: typeof GenericService | null = (hap.Service as any)[serviceName];
  if (service && service.UUID) return service;
  return null;
}

function getAllServiceNames(): string[] {
  return Object.keys(hap.Service).filter(key => getServiceFromConstructorName(key));
}

function deepEqual<T1, T2>(var1: T1, var2: T2): boolean {
  const debug = false;
  if (debug) if (var1 as any === var2 as any) console.log(`var1 as any === var2 as any =>`, true);
  if (var1 as any === var2 as any) return true;
  if (debug) if (typeof var1 !== typeof var2) console.log(`typeof var1 !== typeof var2 =>`, false);
  if (typeof var1 !== typeof var2) return false;
  if (debug) if (var1 === null || var2 === null) console.log(`var1 === null || var2 === null =>`, false);
  if (var1 === null || var2 === null) return false;

  if (typeof var1 === 'object' && typeof var2 === 'object') {
    if (debug) console.log(`typeof var1 === 'object' && typeof var2 === 'object'`);
    for (let key of Object.keys(var1).concat(Object.keys(var2))) {
      if (debug) console.log(`key=`, key);
      const val1 = (var1 as any)[key];
      const val2 = (var2 as any)[key];
      if (debug) if (val1 && !val2) console.log(`key=${key} val1 && !val2 => false`, val1, val2);
      if (val1 && !val2) return false;
      if (debug) if (!val1 && val2) console.log(`key=${key} !val1 && val2 => false`, val1, val2);
      if (!val1 && val2) return false;
      if (debug) if (val1 && val2) console.log(`key=${key} val1 && val2 => check deepEqual`);
      if (val1 && val2 && !deepEqual(val1, val2)) return false;
      if (debug) if (val1 && val2) console.log(`key=${key} val1 && val2 deepEqual was true`);
    }
    if (debug) console.log(`All keys checked => true`);
    return true;
  }
  if (debug) console.log(`all checked val1=${var1} val2=${var2} => false`);
  return false;
}

type AccessoryContext = {
  config: AccessoryConfig;
}

class DomojaPlatform implements DynamicPlatformPlugin {

  private readonly log: Logging;
  private readonly api: API;

  private requestServer?: Server;

  private readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  private socket?: Socket;

  private setCookie: string = '';
  private url: string = '';

  private devices: Map<string, Device> = new Map();

  private devicesLoaded = false;
  private platformDidFinishLaunching = false;

  constructor(log: Logging, __config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;

    let _config = checkConfig(__config, this.log);

    if (_config === false) {
      this.log.error(`Wrong configuration, please fix and restart!`)
      return;
    };

    const config = _config;

    this.url = config.url;


    this.getCookiesFromLogin(config.url, config.auth.username, config.auth.password).then(setCookie => {
      if (setCookie === false) return; // error was logged previously

      this.setCookie = setCookie;

      this.loadDevices(config.url, setCookie).then(() => {
        this.loadAccessories(config);
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

  silentLogin = false;
  loginRetry = 0;
  async getCookiesFromLogin(url: string, username: string, password: string): Promise<string | false> {
    this.loginRetry >= 1 && this.loginRetry <= maxLoggedLoginRetries && this.log.warn(`Retrying connection to domoja server ${this.loginRetry}/${maxLoggedLoginRetries}...`);
    this.loginRetry++;
    try {
      const target = (url.endsWith('/') ? url : url + '/') + "login.html";
      const response = await fetch(target, {
        method: 'POST',
        redirect: "manual",
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&remember_me=true`,
      });

      const text = await response.text(); // unused, just ensure the response is complete

      const setCookie = response.headers.get('Set-Cookie');

      if (setCookie) {
        this.loginRetry > 1 && this.log.warn(`Successful connection to domoja server after ${this.loginRetry} retries!`);
        this.loginRetry = 0;
        this.silentLogin = false;
        this.log.info(`Logged in to domoja server`);

        // setCookie in the form:
        // remember_me=YwqEFCBdzTkCdNHrwcv5XLMrm4mxlX3JlzipsUIhNxFAzvHNivgobjXOgzxFXH25; Max-Age=604800; Path=/; Expires=Mon, 11 Dec 2023 14:29:28 GMT; HttpOnly, connect.sid=s%3AxsjuwzBEeWp1Mq4daDKuxiDMKptgCobc.Iu2ABKTaMtPpNgdUuXKiXi%2FhlYXSfgGwgt4uFiso%2FdQ; Path=/; HttpOnly
        // cookie in the form:
        // remember_me=YwqEFCBdzTkCdNHrwcv5XLMrm4mxlX3JlzipsUIhNxFAzvHNivgobjXOgzxFXH25; connect.sid=s%3AxsjuwzBEeWp1Mq4daDKuxiDMKptgCobc.Iu2ABKTaMtPpNgdUuXKiXi%2FhlYXSfgGwgt4uFiso%2FdQ

        const re = /(?:^| )(?:([^=]+=[^;]*;)(?: [^=,]+=[^;]*;)+ [^,]+,?)/g;
        // finds the name=value; patterns

        const cookies: string[] = [];
        let match: RegExpExecArray | null;
        while (match = re.exec(setCookie)) {
          cookies.push(match[1]);
        }

        return cookies.join(' ');
      }

      if (!this.silentLogin) {
        if (this.loginRetry <= maxLoggedLoginRetries) {
          this.log.warn("Cannot connect to domoja server for login, will retry in ${delayBetweenLoginAttempts} seconds:", response.status, response.statusText);
        } else {
          this.log.warn(`Could not connect for ${maxLoggedLoginRetries} to domoja server for login, continuing silently:`, response.status, response.statusText);
        }
      }
      return new Promise<string | false>(async (resolve, reject) => {
        setTimeout(() => resolve(this.getCookiesFromLogin(url, username, password)), delayBetweenLoginAttempts * 1000);
      });
    } catch (error) {
      if (!this.silentLogin) {
        if (this.loginRetry <= maxLoggedLoginRetries) {
          this.log.warn("Cannot connect to domoja server for login, will retry in ${delayBetweenLoginAttempts} seconds:", error);
        } else {
          this.log.warn(`Could not connect for ${maxLoggedLoginRetries} times to domoja server for login, continuing silently:`, error);
          this.silentLogin = true;
        }
      }
      return new Promise<string | false>(async (resolve, reject) => {
        setTimeout(() => resolve(this.getCookiesFromLogin(url, username, password)), delayBetweenLoginAttempts * 1000);
      });
    };
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

      let updated = false;
      this.accessories.forEach(accessory => {
        if (!accessory.context.config.disabled) {
          accessory.context.config.services.forEach(service => {
            service.characteristics.forEach(characteristic => {
              if (characteristic.get && characteristic.get.device === device.path) {
                if (!updated) this.log.debug(`Device state changed:`, value);
                updated = true;
                this.updateAccessoryCharacteristicFromDeviceState(accessory, service.serviceConstructorName, characteristic.characteristicName, value.newValue);
              }
            });
          });
        }
      });
      if (!updated) this.log.debug(`No accessory using device "${device.path}"!`);

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

  loadAccessories(config: Config): void {

    const cachedAccessories: PlatformAccessory<AccessoryContext>[] = this.accessories.slice();
    this.accessories.splice(0);

    let countNew = 0;
    let countUpdated = 0;
    let countDisabled = 0;
    let countUnchanged = 0;

    config.accessoriesByServiceCharacteristic.forEach(ac => {
      if ('devicesAndDisplayNames' in ac) {
        // accessories by type, let's create one accessory per device
        Object.keys(ac.devicesAndDisplayNames).forEach(devicePath => {
          const device = this.devices.get(devicePath);

          if (!device) {
            this.log.warn(`While loading accessories: could not find device with path "${devicePath}".`);
          } else {

            const service = ac.service;
            const characteristic = ac.characteristic;
            const deviceAndSpecs = ac.devicesAndDisplayNames[devicePath];
            const displayName = typeof deviceAndSpecs === 'string' ? deviceAndSpecs : deviceAndSpecs.displayName;
            const accessoryConfig: AccessoryConfig = {
              displayName: displayName,
              disabled: ac.disabled !== undefined && ac.disabled !== false,
              services: [{
                serviceConstructorName: service,
                characteristics: [{
                  characteristicName: characteristic,
                  get: { device: devicePath, ...ac.get },
                  set: { device: devicePath, ...ac.set },
                }]
              }],
            }

            const existingAccessory = cachedAccessories.find(a =>
              a.context.config.services.length === 1 &&
              a.context.config.services[0].characteristics.length === 1 &&
              a.context.config.services[0].characteristics[0].get &&
              a.context.config.services[0].characteristics[0].get.device === devicePath);

            const needUpdate = existingAccessory && !deepEqual(existingAccessory.context.config, accessoryConfig);

            let accessory: PlatformAccessory<AccessoryContext> | undefined = undefined;
            if (needUpdate) {
              // configuration changed, let's recreate the accessory
              this.log.debug(`In loadAccessories for ${displayName}.${service}.${characteristic}: change in configuration, must recreate the accessory (if not disabled).`);
              this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
              cachedAccessories.splice(cachedAccessories.findIndex(a => a === existingAccessory), 1);
              if (!ac.disabled) {
                countUpdated++;
                this.log.debug(`In loadAccessories for ${displayName}.${service}.${characteristic}: change in configuration, recreating accessory.`);
                accessory = this.addAccessory(accessoryConfig);
              }
            } else if (!existingAccessory) {
              // a really new accessory
              if (!ac.disabled) {
                countNew++;
                this.log.debug(`In loadAccessories for ${displayName}.${service}.${characteristic}: new accessory.`);
                accessory = this.addAccessory(accessoryConfig);
              }
            } else {
              this.log.debug(`In loadAccessories for ${displayName}.${service}.${characteristic}: accessory already exist, and no change detected.`);
              accessory = existingAccessory;
              this.accessories.push(accessory);
              countUnchanged++;
            }

            if (!ac.disabled) {
              if (!accessory) {
                this.log.error(`Error in loadAccessories: no accessory created for ${displayName}.${service}.${characteristic}!`);
              } else {
                const get = accessoryConfig.services.find(s => s.serviceConstructorName === service)?.characteristics.find(c => c.characteristicName === characteristic)?.get;
                if (get)
                  this.updateAccessoryCharacteristicFromDeviceState(accessory, service, characteristic, device.state.toString());
              }
            } else {
              countDisabled++;
            }
          }
        });
      } else {
        // detailed accessory

        const accessoryConfig: AccessoryConfig = {
          displayName: ac.displayName,
          disabled: ac.disabled !== undefined && ac.disabled !== false,
          services: ac.services.map(s => ({
            serviceConstructorName: s.service,
            characteristics: s.characteristics.map(c => {
              return ('device' in c) ? {
                characteristicName: c.characteristic,
                get: { device: c.device, ...c.get },
                set: { device: c.device, ...c.set },
              } : {
                characteristicName: c.characteristic,
                get: 'get' in c ? c.get : undefined,
                set: 'set' in c ? c.set : undefined,
              }
            }),
          })),
        };

        const existingAccessory = cachedAccessories.find(a => a.displayName === ac.displayName);

        const needUpdate = existingAccessory && !deepEqual(existingAccessory.context.config, accessoryConfig);

        let accessory: PlatformAccessory<AccessoryContext> | undefined = undefined;
        if (needUpdate) {
          // configuration changed, let's recreate the accessory
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          cachedAccessories.splice(cachedAccessories.findIndex(a => a === existingAccessory), 1);
          if (!ac.disabled) {
            countUpdated++;
            this.log.debug(`In loadAccessories for ${ac.displayName}: change in configuration, recreating accessory (not disabled).`);
            accessory = this.addAccessory(accessoryConfig);
          }
        } else if (!existingAccessory) {
          // a really new accessory
          if (!ac.disabled) {
            countNew++;
            this.log.debug(`In loadAccessories for ${ac.displayName}: new accessory.`);
            accessory = this.addAccessory(accessoryConfig);
          }
        } else {
          this.log.debug(`In loadAccessories for ${ac.displayName}: accessory already exist, and no change detected.`);
          accessory = existingAccessory;
          this.accessories.push(accessory);
          countUnchanged++;
        }

        if (!ac.disabled) {
          if (!accessory) {
            this.log.error(`Error in loadAccessories: no accessory created for ${ac.displayName}!`);
          } else {
            ac.services.forEach(s => {
              s.characteristics.forEach(c => {
                const device = ('device' in c) ? c.device : 'get' in c ? c.get.device : null;
                if (device) {
                  const d = this.devices.get(device);
                  if (!d) {
                    this.log.error(`Error in loadAccessories: for accessory ${ac.displayName}.${s.service}.${c.characteristic}, could not find device with path "${device}"!`);
                  } else {
                    this.log.debug(`About to update accessory ${ac.displayName}.${s.service}.${c.characteristic}, with device "${device}" state:`, d.state);
                    this.updateAccessoryCharacteristicFromDeviceState(accessory!, s.service, c.characteristic, d.state.toString());
                  }
                } else {
                  // no get defined, hence nothing to update (could be a set-only characteristic)
                }
              });
            })
          }
        } else {
          countDisabled++;
        }
      }
    });

    // deregister unused accessories
    const unusedAccessories = cachedAccessories.filter(a => !this.accessories.includes(a));
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unusedAccessories);

    this.log.info(`Loaded ${countNew} new accessory(ies) from configuration, ${countUnchanged} unchanged, ${countUpdated} updated, ${countDisabled} disabled, ${unusedAccessories.length} removed.`);
  }

  resolveAccessoryServiceCharacteristic(accessory: PlatformAccessory<AccessoryContext>, serviceConstructorName: string, characteristicName: string): Characteristic | undefined {
    const service1 = getServiceFromConstructorName(serviceConstructorName);
    if (!service1) {
      this.log.error(`Error in resolveAccessoryServiceCharacteristic "${accessory.displayName}.${serviceConstructorName}.${characteristicName}": serviceConstructorName not found!`);
      return;
    }
    const service2 = accessory.getService(service1);
    if (!service2) {
      this.log.error(`Error in resolveAccessoryServiceCharacteristic "${accessory.displayName}.${serviceConstructorName}.${characteristicName}": service not found in accessory!`);
      return;
    }
    const characteristic3 = service2.getCharacteristic(characteristicName);
    if (!characteristic3) {
      this.log.error(`Error in resolveAccessoryServiceCharacteristic "${accessory.displayName}.${serviceConstructorName}.${characteristicName}": characteristic not found!`);
      return;
    }
    return characteristic3;
  }

  updateAccessoryCharacteristicFromDeviceState(accessory: PlatformAccessory<AccessoryContext>, serviceConstructorName: string, characteristicName: string, stateValue: string) {
    this.log.debug(`Updating accessory "${accessory.displayName}.${serviceConstructorName}.${characteristicName}" with device state:`, stateValue);

    const characteristic = this.resolveAccessoryServiceCharacteristic(accessory, serviceConstructorName, characteristicName);

    if (!characteristic) {
      this.log.error(`Error while preparing update of accessory "${accessory.displayName}.${serviceConstructorName}.${characteristicName}"!`);
      return;
    }

    const characteristicConfig = accessory.context.config.services.filter(s => s.serviceConstructorName === serviceConstructorName)[0].characteristics.filter(c => c.characteristicName === characteristicName)[0];

    if (!characteristicConfig.get) {
      this.log.error(`Error updateAccessoryCharacteristicFromDeviceState should not be called when no get is defined, for accessory "${accessory.displayName}.${serviceConstructorName}.${characteristicName}"!`);
      return;
    }

    let transformedValue: number | string | boolean | null = this.getTransformedValue(characteristicConfig.get, stateValue);
    if (transformedValue !== null) {
      this.log.info(`${accessory.context.config.displayName}.${serviceConstructorName}.${characteristicName} is now ${transformedValue}`);
      characteristic.updateValue(transformedValue);
    }
  }

  async setDeviceValue(device: Device, value: string | boolean | number, callback: (err?: Error) => void) {
    this.log.debug(`Setting device ${device.path} state to ${value}...`);
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

    accessory.context.config.services.forEach(service => {
      service.characteristics.forEach(characteristic => {
        const characteristic2 = this.resolveAccessoryServiceCharacteristic(accessory, service.serviceConstructorName, characteristic.characteristicName);

        if (!characteristic2) {
          this.log.error(`In configureAccessory: could not find characteristic "${characteristic.characteristicName}" of accessory "${accessory.displayName}"`);
        } else {

          const set = characteristic.set;
          if (!set) return; // no need to create a handler

          characteristic2.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            const device = this.devices.get(set.device);

            if (!device) {
              const error = `While setting ${accessory.context.config.displayName} to ${value}: no device found with path "${set.device}"!`;
              this.log.error(error);
              callback(new Error(error));
            } else {
              let transformedValue: number | string | boolean | null = this.getTransformedValue(set, value.toString());
              if (transformedValue !== null) {
                this.setDeviceValue(device, transformedValue, (err) => {
                  if (err) {
                    this.log.warn(`${accessory.context.config.displayName}.${service.serviceConstructorName}.${characteristic.characteristicName} could not be set to ${value}:`, err);
                  } else {
                    this.log.info(`${accessory.context.config.displayName}.${service.serviceConstructorName}.${characteristic.characteristicName} was set to ${value}`);
                  }
                  callback(err);
                });
              } else callback();
            }
          });
        }
      });
    });

    this.accessories.push(accessory);
  }

  // --------------------------- CUSTOM METHODS ---------------------------

  addAccessory(config: AccessoryConfig): PlatformAccessory<AccessoryContext> {
    this.log.info("Adding new accessory with name %s", config.displayName);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases. But works in this specific example.
    const uuid = hap.uuid.generate(config.displayName);
    const accessory = new Accessory<AccessoryContext>(config.displayName, uuid);

    accessory.context = { config };

    config.services.forEach(serviceConfig => {

      const serviceConstructor = getServiceFromConstructorName(serviceConfig.serviceConstructorName);

      if (!serviceConstructor) {
        this.log.error(`Service "${serviceConfig.serviceConstructorName}" does not exist. Existing services: ${getAllServiceNames().join(', ')}.`);
        return;
      } else {
        if (accessory.getService(serviceConstructor)) {
          this.log.error(`Service "${serviceConfig.serviceConstructorName}" already exist in accessory "${config.displayName}".`);
          return;
        }
      }
      const service = accessory.addService(serviceConstructor, config.displayName);

      serviceConfig.characteristics.forEach(characteristicConfig => {
        // check that characteristic will be OK
        const characteristic = service.getCharacteristic(characteristicConfig.characteristicName);
        if (!characteristic) {
          this.log.error(`Characteristic "${characteristicConfig.characteristicName}" does not exist for service "${serviceConfig.serviceConstructorName}"! Possible characteristics are: ${service.characteristics.map(c => c.displayName).join(', ')}.`);
          this.log.error(`optionals:`, service.optionalCharacteristics);
        }
      });
    });

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    return accessory;
  }

  getTransformedValue(transformSpec: StateMapping | {}, value: string | boolean | number): string | boolean | number | null {
    this.log.debug(`mapping:`, transformSpec);
    this.log.debug(`value:`, value);

    if ('mapping' in transformSpec) {
      if (transformSpec.mapping.length % 2 != 0) this.log.warn(`Mapping "${transformSpec.mapping}" should have a pair length!`);
      for (let i = 0; i < transformSpec.mapping.length; i += 2) {
        const criteria = transformSpec.mapping[i];
        if (criteria === null && value === null) {
          this.log.debug(`transformedvalue:`, transformSpec.mapping[i + 1]);
          return transformSpec.mapping[i + 1];
        }
        if (criteria !== null && value.toString() === criteria.toString()) {
          this.log.debug(`transformedvalue:`, transformSpec.mapping[i + 1]);
          return transformSpec.mapping[i + 1];
        }
        if (criteria === "*" && i === transformSpec.mapping.length - 2) {
          this.log.debug(`transformedvalue:`, transformSpec.mapping[i + 1]);
          return transformSpec.mapping[i + 1];
        }
      }
    }
    this.log.debug(`value not transformed:`, value);
    return value;
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
