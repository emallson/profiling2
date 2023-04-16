local newEstimator = require('moments')
local data = require('./spec/data')
local util = require('./spec/util')

local TOLERANCE = 0.01

describe('moment estimator', function()
  it('should accurately estimate the moments of a normal distribution', function()
    local est = newEstimator()

    for _, sample in ipairs(data.normal) do
      est:update(sample)
    end

    local smean, svar, sskew = util.sample_stats(data.normal)

    assert.are.equal(#data.normal, est:sample_count())

    -- because the mean is close to 0, we use absolute error rather than percentile, which is prone to blowing up
    local mean_err = math.abs(est:mean() - smean)
    local var_err = util.pct_err(est:variance(), svar)
    -- proper normal skewness is 0
    local skew_err = math.abs(est:skewness() - sskew)

    assert.are.near(0, mean_err, TOLERANCE)
    assert.are.near(0, var_err, TOLERANCE)
    assert.are.near(0, skew_err, TOLERANCE)
  end)

  it('should accurately estimate the moments of an exponential distribution', function()
    local est = newEstimator()
    for _, sample in ipairs(data.exponential) do
      est:update(sample)
    end

    local smean, svar, sskew = util.sample_stats(data.exponential)

    assert.are.equal(#data.exponential, est:sample_count())

    local mean_err = util.pct_err(est:mean(), smean)
    local var_err = util.pct_err(est:variance(), svar)
    local skew_err = util.pct_err(est:skewness(), sskew)

    assert.are.near(0, mean_err, TOLERANCE)
    assert.are.near(0, var_err, TOLERANCE)
    assert.are.near(0, skew_err, TOLERANCE)
  end)

  it('should perform acceptably', function()
    -- we should be doing 1 update per frame (as in FPS) per frame (as in CreateFrame)
    -- want to make sure we can do that without issue
    local SIXTY_FPS = 1 / 60
    local loops = 1000
    local TARGET = SIXTY_FPS / 100 * loops
    -- we can handle over 500 frame updates per second with the current code
    local frames = 500
    local ests = {}

    math.randomseed(os.time())

    for _ = 1,frames do
      table.insert(ests, newEstimator())
    end

    local starttime = os.clock()
    for _ = 1,loops do
      -- we have to care about exhausting the rng
      local value = math.random()
      for _, est in ipairs(ests) do
        est:update(value)
      end
    end
    local endtime = os.clock()

    local actual = endtime - starttime
    assert.are.geq(TARGET, actual)
  end)
end)
