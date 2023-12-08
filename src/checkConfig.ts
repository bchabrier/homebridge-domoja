import Ajv2019 from "ajv/dist/2019";
import draft7MetaSchema from 'ajv/dist/refs/json-schema-draft-07.json';
import fs from 'fs';
import { Logging, PlatformConfig } from "homebridge";
import { Config } from "./config";

const ajv = new Ajv2019({
    strict: true,
    ownProperties: true,
    strictRequired: true,
    verbose: true,
    allowUnionTypes: true,
});


ajv.addMetaSchema(draft7MetaSchema);
const SCHEMAFILE = __dirname + '/config.jtd.json';
const TYPEFILE = __dirname + '/config.ts';
const FILE = '~/.homebridge/config.json';

const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMAFILE, 'utf8')));

export default function checkConfig(config: PlatformConfig, log: Logging): Config | false {

    log.debug(`Validating configuration...`);
    if (!validate(config) && validate.errors) {
        log.warn(`Invalid config file "${FILE}":`);
        validate.errors.forEach(err => {
            log.warn(ajv.errorsText([err]).replace("data", FILE));
            if (err.keyword === 'additionalProperties') {
                log.warn(`Property "${err.params.additionalProperty}" in platform "${err.instancePath}".`);
            }
            log.debug('Error:', err);
        });

        //log.warn(ajv.errorsText(validate.errors.map(err => { /*err.instancePath.replace("data", FILE);*/ return err })).replace("data", FILE));
        //if (validate.errors[0].keyword === 'additionalProperties') {
        //    log.warn(`Property "${validate.errors[0].params.additionalProperty}" in platform "${validate.errors[0].instancePath}".`);
        //}
        //log.debug(ajv.errorsText(validate.errors));
        //log.debug(`Errors:`, validate.errors);

        return false;
    } else {

        // check that there are no duplicate display names as these are used to generate the UUIDs
        log.debug(`Configuration is valid!`);
        const typedConfig = config as unknown as Config;

        const accessoryDisplayNames: string[] = [];
        let duplicateDisplayName: string | undefined = undefined;
        let foundDuplicate = typedConfig.accessories.some(accessory => {
            if (accessory.disabled) return false;
            if ('devicesAndDisplayNames' in accessory) {
                return Object.values(accessory.devicesAndDisplayNames).some(spec => {
                    const displayName = (typeof spec === 'string') ? spec : spec.displayName;

                    if (accessoryDisplayNames.includes(displayName)) {
                        duplicateDisplayName = displayName;
                        return true;
                    }
                    accessoryDisplayNames.push(displayName);
                    return false;
                });
            } else {
                if (accessoryDisplayNames.includes(accessory.displayName)) {
                    duplicateDisplayName = accessory.displayName;
                    return true;
                }

                accessoryDisplayNames.push(accessory.displayName);
                return false;
            }
        });
        if (foundDuplicate) {
            log.error(`Error: duplicate accessory "${duplicateDisplayName}" found in configuration!`);
            return false;
        }

        return typedConfig;
    }
}
