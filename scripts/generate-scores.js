/**
 * Script for generating scores spreadsheet using the ground truth file
 */

const d3 = require('d3')
const Papa = require('papaparse')
const fs = require('fs')
const mmwr = require('mmwr-week')
const meta = require('./modules/meta')
const models = require('./modules/models')
const util = require('./modules/util')

const truthFile = './scores/target-multivals.csv'
const outputFile = './scores/scores.csv'
const errorBlacklistFile = './csv-blacklist.yaml'
const errorLogFile = './csv-error.log'

// Using somewhat larger tolerance than Number.EPSILON
const tolerance = 0.0001

/**
 * Return csv data nested using d3.nest
 */
const getCsvData = (csvFile) => {
  let csvData = Papa.parse(fs.readFileSync(csvFile, 'utf8')).data
      .slice(1)
      .filter(d => !(d.length === 1 && d[0] === ''))

  // Location, Target, Type, Unit, Bin_start_incl, Bin_end_notincl, Value
  return d3.nest()
    .key(d => d[0]) // region
    .key(d => d[1]) // target
    .object(csvData)
}

/**
 * Return nested ground truth data
 */
const getTrueData = truthFile => {
  let data = Papa.parse(fs.readFileSync(truthFile, 'utf8')).data
      .slice(1)
      .filter(d => !(d.length === 1 && d[0] === ''))

  // Year, Calendar Week, Season, Model Week, Location, Target, Valid Bin_start_incl
  return d3.nest()
    .key(d => d[0]) // year
    .key(d => d[1]) // epiweek
    .key(d => d[4]) // region
    .key(d => d[5]) // target
    .object(data)
}

/**
 * Not exactly linspace
 */
const arange = (start, end, gap) => {
  let out = [start]
  while (out[out.length - 1] !== end) {
    out.push(out[out.length - 1] + gap)
  }
  return out
}

/**
 * Return a neighbouring region of 1 bin around a given week
 */
const weekNeighbours = (binStart, year) => {
  let lastWeek = (new mmwr.MMWRDate(year, 1)).nWeeks

  // Handle edge cases
  if (binStart === 40) {
    // We are at the beginning of the season
    return [binStart, 41]
  } else if (binStart === lastWeek) {
    // We are the end of year (but somewhere in between for season)
    // The next bin is 1
    return [binStart - 1, binStart, 1]
  } else if (binStart === 1) {
    return [(new mmwr.MMWRDate(year - 1, 1)).nWeeks, binStart, 2]
  } else {
    // This is regular case
    return [binStart - 1, binStart, binStart + 1]
  }
}

/**
 * Return expanded set of binStarts for given bin value and target type
 */
const expandBinStarts = (binStarts, targetType, year) => {
  if (targetType.endsWith('ahead') || targetType.endsWith('percentage')) {
    // This is a percentage target
    return util.unique(binStarts.reduce((acc, binStart) => {
      return acc.concat(
        arange(-0.5, 0.5, 0.1)
          .map(diff => binStart + diff)
          .map(bs => Math.round(bs * 10) / 10) // Round to get just one place decimal
          .filter(bs => (bs >= 0.0 - Number.EPSILON) && (bs <= 13.0 + Number.EPSILON))
      )
    }, []))
  } else {
    // This is a week target
    let uniqueBinStarts = util.unique(binStarts.reduce((acc, binStart) => {
      return acc.concat(weekNeighbours(binStart, year).map(bs => Math.round(bs)))
    }, []))

    // If every one is NaN, then just return one NaN
    if (uniqueBinStarts.every(isNaN)) {
      return [NaN]
    } else {
      return uniqueBinStarts
    }
  }
}

/**
 * Return probability assigned by model for given binStarts
 */
const getBinProbabilities = (csvDataSubset, binStarts) => {
  return binStarts.map(bs => {
    // If bs is NaN, then we look for none bin. This is for onset case
    let filteredRows
    if (isNaN(bs)) {
      filteredRows = csvDataSubset.filter(row => row[4] === 'none')
    } else {
      // Assuming we have a bin here
      filteredRows = csvDataSubset.filter(row => Math.abs(parseFloat(row[4]) - bs) < tolerance)
      if (filteredRows.length === 0) {
        // This is mostly due to week 53 issue, the truth file has week 53 allowed,
        // while the models might not use a bin start using week 53.
        // We jump to week 1 here
        filteredRows = csvDataSubset.filter(row => Math.abs(parseFloat(row[4]) - 1.0) < tolerance)
      }
    }
    return parseFloat(filteredRows[0][6])
  })
}

// E N T R Y  P O I N T
// For each model, for each csv (year, week), for each region, get the 7 targets
// and find log scores, append those to the output file.

// Clear output file
let header = [
  'Model',
  'Year',
  'Epiweek',
  'Season',
  'Model Week',
  'Location',
  'Target',
  'Score',
  'Multi bin score'
]

let outputLines = [header.join(',')]
let errorLogLines = []
let errorBlacklistLines = []
let trueData = getTrueData(truthFile)

// NOTE: For scores, we only consider these two directories
models.getModelDirs(
  './model-forecasts',
  ['component-models', 'cv-ensemble-models']
).forEach(modelDir => {
  let modelId = models.getModelId(modelDir)
  console.log(` > Parsing model ${modelDir}`)
  let csvs = models.getModelCsvs(modelDir)
  console.log(`     Model provides ${csvs.length} CSVs`)

  csvs.forEach(csvFile => {
    let {year, epiweek} = models.getCsvTime(csvFile)
    try {
      let csvData = getCsvData(csvFile)
      meta.regions.forEach(region => {
        meta.targets.forEach(target => {
          let trueTargets = trueData[year][epiweek][region][target]
          let trueBinStarts = trueTargets.map(tt => parseFloat(tt[6]))
          let expandedTrueBinStarts = expandBinStarts(trueBinStarts, target, year)
          let season = trueTargets[0][2]
          let modelWeek = trueTargets[0][3]
          let modelProbabilities = csvData[region][target]
          try {
            let binProbs = getBinProbabilities(modelProbabilities, trueBinStarts)
            let expandedBinProbs = getBinProbabilities(modelProbabilities, expandedTrueBinStarts)
            let score = Math.log(binProbs.reduce((a, b) => a + b, 0))
            let expandedScore = Math.log(expandedBinProbs.reduce((a, b) => a + b, 0))
            if (Math.log(expandedBinProbs.reduce((a, b) => a + b, 0)) > tolerance) {
              console.log(trueBinStarts)
              console.log(binProbs.reduce((a, b) => a + b, 0))
              console.log(score)
              console.log(expandedTrueBinStarts)
              console.log(expandedBinProbs.reduce((a, b) => a + b, 0))
              console.log(expandedScore)
              process.exit(1)
            }
            // Handle infinity scores
            score = score === -Infinity ? 'NaN' : score
            expandedScore = expandedScore === -Infinity ? 'NaN' : expandedScore
            // Handle EPSILON
            score = (-score < tolerance) && (score !== 'NaN') ? 0 : score
            expandedScore = (-expandedScore < tolerance) && (expandedScore !== 'NaN') ? 0 : expandedScore
            outputLines.push(
              `${modelId},${year},${epiweek},${season},${modelWeek},${region},${target},${score},${expandedScore}`
            )
          } catch (e) {
            errorLogLines.push(`Error in ${modelId} ${year}-${epiweek} for ${region}, ${target}`)
            errorLogLines.push(e.name)
            errorLogLines.push(e.message)
            errorLogLines.push('')
            errorBlacklistLines.push(`- ${csvFile}`)
            console.log(` # Error in ${modelId} ${year}-${epiweek} for ${region}, ${target}`)
            console.log(e)
          }
        })
      })
    } catch (e) {
      errorLogLines.push(`Error in ${csvFile}`)
      errorLogLines.push(e.name)
      errorLogLines.push(e.message)
      errorLogLines.push('')
      errorBlacklistLines.push(`- ${csvFile}`)
      console.log(` # Error in ${csvFile}`)
      console.log(e)
    }
  })
})

// The main scores.csv
util.writeLines(outputLines, outputFile)

// Error logs
util.writeLines(util.unique(errorBlacklistLines), errorBlacklistFile)
util.writeLines(errorLogLines, errorLogFile)
