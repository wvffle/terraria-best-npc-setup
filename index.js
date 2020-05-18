const $ = require('cheerio')
const request = require('request-promise')
const Chance = require('chance')
const PriorityQueue = require('fastpriorityqueue')
const { promises: fs } = require('fs')
const crypto = require('crypto')

const WIKI_URL = 'https://terraria.gamepedia.com/NPCs'
const PREFERENCES_ID = 'NPC_preferences'

// Base happiness multiplier
const BASE_HAPPINESS = 1e6

// Loop timeout
const TIMEOUT = 3e4

// Maximum avg. modifier
const MAX_MOD = 96.66

const NPC_BLACKLIST = [
    'Santa Claus'
]

const BIOME_MOD = {
    loves: 0.9,
    likes: 0.95,
    dislikes: 1.5,
    hates: 1.1
}

const NPC_MOD = {
    loves: 0.9,
    likes: 0.95,
    dislikes: 1.5,
    hates: 1.1
}

const NEIGHBOUR_MOD = {
    2: 0.9,
    3: 1
}

const biomes = new Set(['Mushroom'])

class NPC {
    static map = new Map()
    #happiness = {}

    constructor (name) {
        this.name = name
        this.cities = new Set()

        this.biome = {
            likes: null,
            loves: null,
            dislikes: null,
            hates: null
        }

        this.npcs = {
            likes: [],
            loves: [],
            dislikes: [],
            hates: []
        }

        NPC.map.set(this.name, this)
        this.id = 1 << NPC.map.size
    }

    static fromTr ({ children: tr }) {
        const name = $(tr[1]).text().trim()
        const npc = new NPC(name)

        // Biome relations
        const biome1 = $(tr[3]).text().trim()
        const biome2 = $(tr[5]).text().trim()

        if (biome1.includes('Likes')) {
            npc.biome.likes = biome1.slice(6)
            biomes.add(biome1.slice(6))
        } else if (biome1.includes('Loves')) {
            npc.biome.loves = biome1.slice(6)
            biomes.add(biome1.slice(6))
        }

        if (biome2.includes('Dislikes')) {
            npc.biome.dislikes = biome2.slice(9)
            biomes.add(biome2.slice(9))
        } else if (biome2.includes('Hates')) {
            npc.biome.hates = biome2.slice(6)
            biomes.add(biome2.slice(6))
        }

        // NPC relations
        for (const rel_npc of $(tr[7]).find('.item-link').toArray()) {
            npc.npcs.loves.push($(rel_npc).text().trim())
        }

        for (const rel_npc of $(tr[9]).find('.item-link').toArray()) {
            npc.npcs.likes.push($(rel_npc).text().trim())
        }

        for (const rel_npc of $(tr[11]).find('.item-link').toArray()) {
            npc.npcs.dislikes.push($(rel_npc).text().trim())
        }

        for (const rel_npc of $(tr[13]).find('.item-link').toArray()) {
            npc.npcs.hates.push($(rel_npc).text().trim())
        }

        return npc
    }

    join (city) {
        this.cities.add(city)
    }

    #biomeHappiness = function (biome) {
        if (biome in this.#happiness) {
            return this.#happiness[biome]
        }

        let base = BASE_HAPPINESS

        for (const [status, value] of Object.entries(this.biome)) {
            if (biome === value) {
                base *= BIOME_MOD[status]
            }
        }

        return (this.#happiness[biome] = base)
    }

    happiness (biome, npcs = new Set()) {
        let base = this.#biomeHappiness(biome)

        for (const npc of npcs) {
            for (const status in this.npcs) {
                if (this.npcs[status].includes(npc)) {
                    base *= NPC_MOD[status]
                }
            }
        }

        base *= NEIGHBOUR_MOD[npcs.size]

        return base
    }
}

class City {
    static array = []
    static _map = new Map()
    #happiness = null

    constructor (biome) {
        this.biome = biome
        this.npcs = new Set()
        City.array.push(this)
        this._id = ''
        this._npcs = 0
    }

    static exists (biome, npcs) {
        const id = City.genId(biome, npcs)
        return City._map.has(id)
    }

    static genId (biome, npcs) {
        return biome + '#' + npcs.sort().join('|')
    }

    addNPC (npc) {
        this.npcs.add(npc.name)
        this._npcs |= npc.id
        npc.join(this)
    }

    closeBorders () {
        const id = City.genId(this.biome, [...this.npcs.values()])
        City._map.set(id, this)
    }

    happiness () {
        if (this.#happiness) {
            return this.#happiness
        }

        let h = 0

        for (const name of this.npcs.values()) {
            const npc = NPC.map.get(name)
            h += npc.happiness(this.biome, this.npcs)
        }

        return (this.#happiness = h / this.npcs.size)
    }

    sharesNPC (city) {
        return !!(city._npcs & this._npcs)
    }

    toString () {
        const npcs = [...this.npcs.values()].join(', ')
        return `${(this.happiness() / BASE_HAPPINESS * 100).toFixed(2)}% | ${this.biome} | ${npcs}`
    }
}

let exit = false
;(async function () {
    console.log('Fetching data from wiki')

    const html = await request(WIKI_URL)
    const table = $(`#${PREFERENCES_ID}`, html).parent().next().children(':first-child')

    console.log('Creating NPCs')
    for (const tr of table.find('tr').slice(2).toArray()) {
        const npc = NPC.fromTr(tr)

        // Remove blacklisted
        if (NPC_BLACKLIST.includes(npc.name)) {
            NPC.map.delete(npc.name)
        }
    }

    const npc_num = NPC.map.size
    console.log(`Fetched ${npc_num} NPCs`)

    const constraints = {
        ['Witch Doctor'] (biome) {
            return biome === 'Jungle'
        },

        ['Pirate'] (biome) {
            return biome === 'Ocean'
        },

        ['Truffle'] (biome) {
            return biome === 'Mushroom'
        },

        ['Nurse'] (biome, npcs) {
            return (biome === 'Hallow' || biome === 'Desert')
                && npcs.length === 2
                && npcs.some(npc => npc.name !== 'Arms Dealer')
        },

        all (biome, npcs) {
            if (biome === 'Mushroom') {
                return npcs.some(npc => npc.name === 'Truffle')
            }

            return true
        }
    }

    console.log('Creating 2-NPC cities')
    for (const npc1 of NPC.map.values()) {
        for (const npc2 of NPC.map.values()) {
            for (const biome of biomes.values()) {
                if (npc1 === npc2) {
                    continue
                }

                let skip = false
                for (const npc of [npc1, npc2]) {
                    if (npc.name in constraints) {
                        if (!constraints[npc.name](biome, [npc1, npc2])) {
                            skip = true
                            break
                        }
                    }
                }

                if (skip || !constraints.all(biome, [npc1, npc2])) {
                    continue
                }

                if (!City.exists(biome, [npc1, npc2].map(n => n.name))) {
                    const city = new City(biome)
                    city.addNPC(npc1)
                    city.addNPC(npc2)
                    city.closeBorders()
                }
            }
        }
    }

    console.log('Creating 3-NPC cities')
    for (const npc1 of NPC.map.values()) {
        for (const npc2 of NPC.map.values()) {
            for (const npc3 of NPC.map.values()) {
                for (const biome of biomes.values()) {
                    if (npc1 === npc2 || npc2 === npc3 || npc1 === npc3) {
                        continue
                    }

                    let skip = false
                    for (const npc of [npc1, npc2, npc3]) {
                        if (npc.name in constraints) {
                            if (!constraints[npc.name](biome, [npc1, npc2, npc3])) {
                                skip = true
                                break
                            }
                        }
                    }

                    if (skip || !constraints.all(biome, [npc1, npc2, npc3])) {
                        continue
                    }

                    if (!City.exists(biome, [npc1, npc2, npc3].map(n => n.name))) {
                        const city = new City(biome)
                        city.addNPC(npc1)
                        city.addNPC(npc2)
                        city.addNPC(npc3)
                        city.closeBorders()
                    }
                }
            }
        }
    }

    console.log('Sorting cities')
    const cities = City.array.sort((city1, city2) => {
        if (city1.happiness() < city2.happiness()) return -1
        if (city1.happiness() > city2.happiness()) return +1
        return 0
    })



    let seen = {}

    try {
        const buf = await fs.readFile('cache.json')
        const cache = JSON.parse(`${buf}`)

        for (const entry of cache) {
            seen[entry] = true
        }
    } catch {}

    const results = []
    const serialized_cities = cities.map((city, id) => ({
        npcs_num: city.npcs.size,
        score: city.happiness(),
        biome: city.biome,
        npcs: city._npcs,
        hash: city.toString(),
        id
    }))

    const chance = new Chance()

    console.log('Randomly getting correct city')
    let then = +new Date()
    while (exit === false) {
        const candidate = {
            hash: crypto.createHash('sha512'),
            cities: new PriorityQueue(),
            biomes: new Set(),
            npcs_num: 0,
            score: 0,
            npcs: 0
        }

        const possible_cities = [...serialized_cities].filter(city => city.score < BASE_HAPPINESS * MAX_MOD / 100)

        // NOTE: The lowest we have is 2-NPC cities
        //       So there is no way to match last NPC
        while (candidate.npcs_num < npc_num - 1 && possible_cities.length > 0 && exit === false) {
            if (+new Date() - then > TIMEOUT) {
                exit = true
                console.log('TIMED OUT')
                continue
            }

            const i = chance.integer({ min: 0, max: possible_cities.length - 1 })
            const city = possible_cities[i]
            possible_cities.splice(i, 1)

            if (candidate.npcs & city.npcs) {
                continue
            }

            if (candidate.npcs_num + city.npcs_num > npc_num) {
                continue
            }

            candidate.cities.add(city.id)
            candidate.npcs |= city.npcs
            candidate.npcs_num += city.npcs_num
            candidate.score += city.score
            candidate.biomes.add(city.biome)
        }

        if (candidate.npcs_num === npc_num) {
            candidate.score /= candidate.cities.size

            candidate.cities.forEach(id => {
                candidate.hash.update(`$${serialized_cities[id].hash}`)
            })

            const hash = candidate.hash.digest('hex')
            if (seen[hash] !== true && candidate.score < BASE_HAPPINESS && candidate.biomes.size === 8) {
                seen[hash] = true
                results.push(candidate)

                console.log(`World #${results.length} found, ${+new Date () - then}ms`)
                then = +new Date()
            }
        }
    }

    let prev_score = BASE_HAPPINESS * 2

    await fs.writeFile('cache.json', JSON.stringify(Object.keys(seen)))

    try {
        const fp = await fs.readFile(`${__dirname}/README.md`)
        const score = parseInt(`${fp}`.match(/Score: (\d+)/)[1], 10)

        if (!isNaN(score)) {
            prev_score = score
            console.log(`Old score: ${score}`)
        }
    } catch {}

    const best = results.sort((city1, city2) => {
        if (city1.score < city2.score) return -1
        if (city1.score > city2.score) return +1
        return 0
    })[0]

    if (!best || prev_score <= best.score) {
        console.log(`No new score found. No changes`)
        return
    }

    console.log(`New best city found`)

    let readme = '## Best case\n'

    readme += `Score: ${best.score ^ 0}\n\n`
    readme += 'Avg. Modifier | Biome | NPCs\n'
    readme += '-------- | ----- | ----\n'
    best.cities.forEach(id => {
        const city = cities[id]
        readme += `${city}\n`
    })


    readme += '\n'
    readme += '## Modifier table\n'
    readme += 'Avg. Modifier | Biome | NPCs\n'
    readme += '-------- | ----- | ----\n'

    for (const city of cities) {
        readme += `${city}\n`
    }

    await fs.writeFile(`${__dirname}/README.md`, readme)
})()

process.on('unhandledRejection', err => {
    console.error(err)
    process.exit(1)
})