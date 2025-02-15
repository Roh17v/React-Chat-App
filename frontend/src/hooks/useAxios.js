import axios from "axios";
import { useEffect, useState } from "react";


const useAxios = (url, options, dependencies=[]) => {
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let isMounted = true;
        const fetchData = async () => {
            setLoading(true);
            setError(null);

            try {
                const response = await axios(url, options);
                return setData(response.data);
            } catch (error) {
                setError(error);
                return null;
            }
            finally{
                setLoading(false);
            }
        };

        fetchData();
    }, dependencies)

    const reFetch = async () => {
        setLoading(true);
        try {
            const response = await axios(url, options);
            return setData(response.data);
        } catch (error) {
            setError(error);
            return null;
        }
        finally{
            setLoading(false);
        }
    }

    return {data, loading, error, reFetch};

}

export default useAxios;