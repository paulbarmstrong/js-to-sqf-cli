### js-to-sqf-cli

This is a CLI tool for transpiling javascript to SQF (Status Quo Format). Users write javascript (or typescript) using the functions from the js-to-sqf NPM package to represent commands in SQF. Then the js-to-sqf-cli tool uses the typescript compiler API to transpile the javascript code into SQF.

#### Usage

Imports from the `js-to-sqf` NPM package are what allow users to interact with the SQF scripting environment.

Users should write `src/index.js` or `src/index.ts` as exporting a default `MissionDefinition` object. The following event scripts are configurable in the `MissionDefinition` and serve as the entry points to the mission scripting.
* `[init](https://community.bistudio.com/wiki/Event_Scripts#init.sqf)`
* `[initServer](https://community.bistudio.com/wiki/Event_Scripts#initServer.sqf)`
* `[initPlayerLocal](https://community.bistudio.com/wiki/Event_Scripts#initPlayerLocal.sqf)`

The `js-to-sqf` NPM package provides javascript functions representing any SQF command. It also provides a javascript function per BIS SQF function under the `bis` object.

Users may organize their javascript code in other files within the `src` directory.

#### Limitations

* It's only suitable for "mission" projects
* Mutating variables outside of functions are not supported
* Imports from packages other than `js-to-sqf` are not supported
* All variables outside of a function must be const, must not mutate, and may only depend on other variables declared earlier in the same file
* Classes are not supported
* Only these native javascript variable types are supported:
  * number
  * string
  * boolean
  * Array
