
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data: itineraries } = await supabase.schema('travel').from('itineraries').select('id').eq('is_public', true).limit(1);
  if (!itineraries || itineraries.length === 0) {
    console.log('No public itineraries found');
    return;
  }
  const id = itineraries[0].id;
  console.log('Testing query for itinerary:', id);
  
  const { data, error } = await supabase
    .schema('travel')
    .from('itinerary_details')
    .select('itinerary_id, places:place_id(image_url)')
    .in('itinerary_id', [id]);
    
  if (error) {
    console.error('Error:', JSON.stringify(error, null, 2));
  } else {
    console.log('Success:', JSON.stringify(data, null, 2));
  }
}
run();
