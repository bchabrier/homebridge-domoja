# homebridge-domoja

This Homebridge plugin adds devices managed by [domoja](https://www.npmjs.com/package/domoja) to Homekit.

## Configuration file

### Sample configuration file:
```
  "platforms": [
    {
      "platform": "DomojaPlatform",
      "url": "http://domoja.server.url/",
      "auth": {
        "username": "XXXXX",
        "password": "XXXXX"
      },
      "accessories": [ 
        {
          "description": "Detailed accessory description",
          "displayName": "Grand Portail",
          "services": [
            {
              "service": "GarageDoorOpener",
              "characteristics" : [
                { 
                  "characteristic" : "Target Door State",
                  "get": {
                    "device": "portails.grand_portail.état",
                    "mapping": ["Ouvert", 0, "Fermé", 1, "Entrouvert", null, "*", null]
                  },
                  "set": {
                    "device": "portails.grand_portail.grand",
                    "mapping": [1, "impulse", 0, "impulse"]
                  }
                },
                { 
                  "characteristic" : "Current Door State",
                  "get": {
                    "device": "portails.grand_portail.état",
                    "mapping": ["Ouvert", 0, "Fermé", 1, "Entrouvert", null]
                  }
                }
              ]
            }
          ]
        },
        {
          "description": "Motion sensor type accessories",
          "service": "MotionSensor",
          "characteristic": "Motion Detected",
          "get": {
            "mapping": ["ON", true, "OFF", false]
          },
          "devicesAndDisplayNames": {
            "hall": "Hall",
            "cuisine": "Cuisine",
            "escalier": "Escalier",
            "bureau": "Bureau",
            "salle_a_manger": "Salle à manger"
          }  
        }
      ]
    }
  ],
```
### Authentication

The `auth` block contains the credentials of the user.

### Accessories

Accessories can be configured through two different ways:

- by detailed configuration:

    Here only one accessory is described, service by service, and for each service, characteristic by characteristic. 

- by type: 

    Here an accessory type is defined, with once service and one characteristic in this service only, and then associated to several domoja devices, thus configuring several accessories at once.

Services are refered by their constructor name (the service name with no separating blanks), while characteristics are refered by their name.

The list of available services and associated characteristics can be found [here](https://github.com/brutella/hap/blob/master/service/README.md), or here:

`homebridge-domoja\node_modules\hap-nodejs\dist\lib\definitions\ServiceDefinitions.js`

### `get` and `set`
Characteristics take their value from a domoja device state. Reversely, setting a characteristic value can set a device state. Which device state to set or get is defined by the `set` and `get` blocks.

### `mapping`
If a characteristic value needs to be transformed into a device state, and vice-versa, then a `mapping` block can be defined. It consists in an array of values. The array has a pair length. Each value is followed by its transformed value. A `null` transformed value means that no transformed value will be used (i.e., the characteristic will not be updated - in a `get` block -, or the device state will not be set - in a `set` block -).


