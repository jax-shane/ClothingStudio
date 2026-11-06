'use strict';
// The choices behind a piece's "options": audio, flags, render flag. The lists are the ones grzyClothTool offers
// (flag values from the game's ePedCompFlags, see https://alexguirre.github.io/rage-parser-dumps/).

const DRAWABLE_FLAGS = [
  ['BULKY', 1], ['JOB', 2], ['SUNNY', 4], ['WET', 8], ['COLD', 16], ['NOT_IN_CAR', 32], ['BIKE_ONLY', 64], ['NOT_INDOORS', 128],
  ['FIRE_RETARDENT', 256], ['ARMOURED', 512], ['LIGHTLY_ARMOURED', 1024], ['HIGH_DETAIL', 2048], ['DEFAULT_HELMET', 4096],
  ['RANDOM_HELMET', 8192], ['SCRIPT_HELMET', 16384], ['FLIGHT_HELMET', 32768], ['HIDE_IN_FIRST_PERSON', 65536],
  ['USE_PHYSICS_HAT_2', 131072], ['PILOT_HELMET', 262144], ['WET_MORE_WET', 524288], ['WET_LESS_WET', 1048576],
];

// ePropRenderFlags as the game / CodeWalker define it: ALPHA = 0 (what a prop without a flag already is), DECAL = 1, CUTOUT = 2.
const RENDER_FLAGS = [['PRF_ALPHA', 0], ['PRF_DECAL', 1], ['PRF_CUTOUT', 2]];

const AUDIO = {
  berd: ['none', 'cloth_scuba'],
  uppr: ['none', 'cloth_default', 'cloth_upper_bare', 'cloth_upper_sweater', 'cloth_upper_shirt_tee', 'cloth_upper_shirt_cotton_lite',
    'cloth_upper_shirt_cotton_heavy', 'cloth_upper_jacket_cotton', 'cloth_upper_jacket_puffy', 'cloth_upper_jacket_leather',
    'cloth_upper_jacket_suit', 'cloth_upper_bikini_top', 'cloth_upper_spacesuit', 'cloth_upper_alien', 'cloth_upper_coat_scientist',
    'cloth_upper_cop_vest_helmet'],
  lowr: ['none', 'cloth_default', 'cloth_lower_cotton', 'cloth_lower_leather', 'cloth_lower_shorts', 'cloth_lower_pants_leather',
    'cloth_lower_pants_denim', 'cloth_lower_pants_suit', 'cloth_lower_pants_tight', 'cloth_lower_skirt_short', 'cloth_lower_skirt_long',
    'cloth_lower_waterproof', 'cloth_lower_bare', 'cloth_lower_ballistic_armour', 'cloth_lower_extreme', 'cloth_lower_swat',
    'cloth_lower_fireman', 'cloth_lower_fireman_lower'],
  hand: ['none', 'cloth_rappel_parachute', 'cloth_heavy_bag'],
  feet: ['none', 'footsteps_generic', 'shoe_barefoot', 'shoe_heels', 'shoe_normal_heels', 'shoe_high_heels', 'shoe_heavy_boots',
    'shoe_rubber_boots', 'shoe_rubber', 'shoe_flip_flops', 'shoe_dress_shoes', 'shoe_trainers', 'shoe_scuba_flippers',
    'shoe_cowboy_boots', 'shoe_clown_shoes', 'shoe_gold_shoes', 'shoe_silent'],
  accs: ['none', 'cloth_default', 'cloth_upper_shirt_tee', 'cloth_upper_cotton', 'cloth_upper_shirt_cotton_lite', 'cloth_upper_jacket_puffy',
    'cloth_upper_jacket_suit', 'cloth_upper_ballistic_armour', 'cloth_upper_bikini_top', 'cloth_upper_cop_vest', 'cloth_scuba',
    'cloth_cop_belt', 'cloth_gas_mask'],
  task: ['none', 'cloth_ballistic', 'cloth_backpack', 'cloth_tool_belt'],
  jbib: ['none', 'cloth_default', 'cloth_upper_bare', 'cloth_upper_leather', 'cloth_upper_sweater', 'cloth_upper_cotton',
    'cloth_upper_shirt_tee', 'cloth_upper_shirt_cotton_lite', 'cloth_upper_shirt_cotton_heavy', 'cloth_upper_shirt_leather',
    'cloth_upper_jacket_cotton', 'cloth_upper_jacket_puffy', 'cloth_upper_jacket_leather', 'cloth_upper_jacket_suit',
    'cloth_upper_bikini_top', 'cloth_upper_waterproof', 'cloth_upper_ballistic_armour', 'cloth_upper_spacesuit',
    'cloth_upper_swat', 'cloth_upper_fireman', 'cloth_upper_kifflom', 'cloth_upper_alien'],
};

/** audio names offered for a component slot (props only offer "none") */
const audioList = (prop, comp) => (prop ? ['none'] : AUDIO[comp] || ['none']);

module.exports = { DRAWABLE_FLAGS, RENDER_FLAGS, AUDIO, audioList };
