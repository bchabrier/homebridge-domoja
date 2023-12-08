import { PlatformConfig } from "homebridge";

export type StateMapping = {
    mapping: (boolean | string | number | null)[]; //  [ "ON", false, "OFF", true, "*", null ]
};

export type AccessoryConfig = {
    displayName: string;
    disabled: boolean;
    services: {
        serviceConstructorName: string;
        characteristics: {
            characteristicConstructorName: string;
            set?: { device: string; } & (StateMapping | {}),
            get?: { device: string; } & (StateMapping | {}),
        }[];
    }[];
}


// service and characteristic names can be found here: https://github.com/brutella/hap/blob/master/service/README.md

type AccessoriesByServiceCharacteristic = {
    disabled?: boolean;
    description?: string;
    service: string; // "Switch": Service constructor name
    characteristic: string; // "On": Characteristic name
    get?: StateMapping;
    set?: StateMapping;
    devicesAndDisplayNames: {
        [devicePath: string]: string | { // "aquarium.lampes": "Lampes aquarium"
            displayName: string;
        }; // "aquarium.lampes": { displayName: "Lampes aquarium", "category": "LIGHTBULB"}
    }
}

type DetailedAccessory = {
    disabled?: boolean;
    description?: string,
    displayName: string,
    services: {
        service: string,
        characteristics:
        (
            {
                characteristic: string,
                device: string,
                set?: StateMapping,
                get?: StateMapping,
            } | {
                characteristic: string,
                set: { device: string; } & (StateMapping | {}),
                get: { device: string; } & (StateMapping | {}),
            } | {
                characteristic: string,
                get: { device: string; } & (StateMapping | {}),
            } | {
                characteristic: string,
                set: { device: string; } & (StateMapping | {}),
            }
        )[],
    }[]
};

export type Config = PlatformConfig & {
    url: string;
    auth: {
        username: string;
        password: string;
    };
    accessories: (AccessoriesByServiceCharacteristic | DetailedAccessory)[];
};
