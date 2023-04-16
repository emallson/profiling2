local newReservoir = require('reservoir')
local data = require('./spec/data')
local util = require('./spec/util')

-- normal critical value for .95
local Z = 1.960

-- chi^2 critical values for .99
local alpha_lower= 134.642
local alpha_upper = 69.230

math.randomseed(os.time())

describe('the reservoir sampler', function()
  it('should generate a representative sample of normally distributed data at k=100', function()
    local COUNT = 100
    local reservoir = newReservoir(COUNT)
    for _, value in ipairs(data.normal) do
      reservoir:update(value)
    end

    assert.are.equal(reservoir:sample_count(), COUNT)

    local rSample = reservoir:samples()

    local rMean, rVar = util.sample_stats(rSample)
    local sMean, sVar = util.sample_stats(data.normal)

    local meanInterval = Z * math.sqrt(rVar / COUNT)
    local varLower = (COUNT - 1) * rVar / alpha_lower
    local varUpper = (COUNT - 1) * rVar / alpha_upper

    assert.are.near(sMean, rMean, meanInterval)
    assert.are.geq(varUpper, sVar)
    assert.are.leq(varLower, sVar)
  end)

  it('should have acceptable performance', function()
    local RENDERS = 1000
    -- we can handle over 1000 frame updates per second with the current code
    local FRAMES = 400

    local resvs = {}
    for _ = 1, FRAMES do
      table.insert(resvs, newReservoir(200))
    end

    local starttime = os.clock()
    for _ = 1, RENDERS do
      local value = math.random()
      for _, resv in ipairs(resvs) do
        resv:update(value)
      end
    end
    local endtime = os.clock()

    local SIXTY_FPS = 1 / 60
    local TARGET = SIXTY_FPS / 100 * RENDERS
    local actual = endtime - starttime
    assert.are.geq(TARGET, actual)
  end)
end)
